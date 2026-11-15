// ci: web-runner order=125 chrome
// The import search's folder listings (src/compile.ts absentFrom, as CPython's FileFinder) in the browser's worker, in
// headless Chromium against the built worker (web/worker.ts, web/shims/fs.ts).  A folder's listing is kept while its
// mtime, importlib.invalidate_caches()'s generation and the listing epoch (src/runtime/listing-epoch.ts) stay the same,
// and only an absence is taken from it.  Checks:
// - a notebook's worker (its files in memory): a folder's mtime moves when a file is made in it, as POSIX's; a module
//   the page puts between two runs is found by the second; one a run writes is found by its next import;
// - a Terminal command's worker (its files the page's, whose folders' times never move): a module the command writes
//   is found by its next import; one the page adds while it runs is found only after importlib.invalidate_caches(),
//   as CPython's when a folder's mtime doesn't change; importing library modules asks the page nothing about the
//   names the folder doesn't have (one listing, no stat of NAME.py or NAME/__init__.py).
//   bun web/build.ts, then node web/test-import-listing.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "./test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-import-listing-"));
// (the page's side of the Terminal's file channel, as a script the page evaluates: window.TermSync)
const entry = join(tmp, "entry.ts");
writeFileSync(entry, `import * as S from ${JSON.stringify(join(here, "term-sync.ts"))};\n(globalThis as any).TermSync = S;\n`);
execFileSync("bun", ["build", entry, "--target=browser", "--format=iife", `--outfile=${join(tmp, "ts.js")}`], { stdio: ["ignore", "ignore", "inherit"] });
const pageSide = readFileSync(join(tmp, "ts.js"), "utf8");
const serve = spawn("python3", [join(here, "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m.result ?? m.error);
    waiting.delete(m.id);
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
};
const fails = [];
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) fails.push(what);
};

// A notebook's worker, kept across runs: nb.start(files, dir), nb.run(code) -> {stdout, stderr, error},
// nb.put(path, text): a file the page saved meanwhile (web/worker.ts fsPut)
const notebook = `(() => {
  let w = null, next = 0;
  const runs = new Map();
  window.nb = {
    start(files, dir) {
      w = new Worker("sagebrush-worker.js", { type: "module" });
      w.onmessage = (e) => {
        const m = e.data, r = runs.get(m?.id);
        if (!r) return;
        if (m.stream) r.out[m.stream] += m.text;
        if (m.done) { runs.delete(m.id); r.res({ ...r.out, error: m.error ?? null }); }
      };
      w.postMessage({ files: files.map(([p, t]) => [p, new TextEncoder().encode(t)]) });
      w.postMessage({ startDir: dir });
      w.postMessage({ init: { limits: null } });
      return true;
    },
    run(code) {
      const id = ++next;
      return new Promise((res) => { runs.set(id, { res, out: { stdout: "", stderr: "" } }); w.postMessage({ id, code }); });
    },
    put(path, text) { w.postMessage({ fsPut: path, data: new TextEncoder().encode(text) }); return true; },
    stop() { w.terminate(); return true; },
  };
  return true;
})()`;

// A Terminal command in a fresh worker, its files the page's (window.WS: path -> {fid, rev, bytes}); every request the
// page answers is logged ([op, path]); `onRead[path]` runs when the page serves that file's bytes
const terminal = `(() => {
  const enc = new TextEncoder();
  let fid = 1;
  window.WS = new Map();
  window.put = (p, text) => window.WS.set(p, { fid: "f" + fid++, rev: 1, bytes: enc.encode(text) });
  window.command = (code, onRead = {}) => new Promise((res) => {
    const w = new Worker("sagebrush-worker.js", { type: "module" });
    const log = [];
    const err = (code, message) => ({ error: { code, message } });
    const handler = async (h) => {
      const a = h.args, f = window.WS.get(a.path);
      log.push([h.op, a.path ?? a.from ?? ""]);
      const isDir = (p) => p === "/" || [...window.WS.keys()].some((k) => k.startsWith(p + "/"));
      if (h.op === "stat") return f ? { json: { kind: "file", size: f.bytes.length, mtime: 1, fid: f.fid, rev: f.rev } } : isDir(a.path) ? { json: { kind: "folder", size: 0, mtime: 1, fid: "d" + a.path, rev: 0 } } : err("ENOENT", a.path + ": No such file or directory");
      if (h.op === "open") return f ? { json: { fid: f.fid, rev: f.rev, size: f.bytes.length } } : err("ENOENT", a.path + ": No such file or directory");
      if (h.op === "openw") { if (!f) window.WS.set(a.path, { fid: "f" + fid++, rev: 1, bytes: new Uint8Array(0) }); const g = window.WS.get(a.path); if (a.trunc) { g.bytes = new Uint8Array(0); g.rev++; } return { json: { fid: g.fid, rev: g.rev } }; }
      if (h.op === "read") {
        const g = [...window.WS.entries()].find(([, x]) => x.fid === a.fid);
        if (g && onRead[g[0]]) { const [p, t] = onRead[g[0]]; delete onRead[g[0]]; window.put(p, t); }
        return g ? { bytes: g[1].bytes.slice(a.pos, a.pos + a.max) } : err("EBADF", "the file was removed");
      }
      if (h.op === "list") return isDir(a.path) ? { json: [...new Set([...window.WS.keys()].filter((k) => k.startsWith(a.path === "/" ? "/" : a.path + "/")).map((k) => k.slice(a.path === "/" ? 1 : a.path.length + 1).split("/")[0]))] } : f ? err("ENOTDIR", a.path + ": Not a directory") : err("ENOENT", a.path + ": No such file or directory");
      if (h.op === "write") return { admit: async (body) => {
        let g = a.fid ? [...window.WS.values()].find((x) => x.fid === a.fid) : window.WS.get(a.path);
        if (!g) { window.WS.set(a.path, { fid: "f" + fid++, rev: 0, bytes: new Uint8Array(0) }); g = window.WS.get(a.path); }
        const base = a.mode === "replace" ? new Uint8Array(0) : g.bytes;
        const at = a.mode === "append" ? base.length : a.mode === "at" ? a.pos : 0;
        const out = new Uint8Array(Math.max(base.length, at + body.length)); out.set(base); out.set(body, at);
        g.bytes = out; g.rev++;
        return { json: { fid: g.fid, rev: g.rev, size: out.length } };
      } };
      return err("EINVAL", "op " + h.op);
    };
    const page = new TermSync.PageChannel(1, handler);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.fsSync || m.fsMore) { page.onMessage(m).catch((x) => console.error(x)); return; }
      if (m.termDone || m.termRefused) { w.terminate(); res({ ...(m.termDone ?? { refused: m.termRefused }), log }); }
    };
    setTimeout(() => { w.terminate(); res({ timeout: true, log }); }, 90000);
    w.postMessage({ init: { limits: null } });
    const plan = { run: true, mode: "python", argv0: "python", source: { kind: "code", code }, argv: ["-c"], path0: "/w" };
    w.postMessage({ term: { gen: 1, plan, cwd: "/w", stdin: new Uint8Array(0), env: { COLUMNS: 100, LINES: 30 }, out: { allowance: 1 << 20, backstop: 32 << 20 }, sync: { control: page.control, data: page.data } } });
  });
  return true;
})()`;

// (an import that may fail: "absent" when it does)
const tryImport = (name, label = "absent") => `try:\n    import ${name}\nexcept ModuleNotFoundError:\n    print(${JSON.stringify(label)})\n`;

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);
  check((await ev("self.crossOriginIsolated")) === true, "the page is cross-origin isolated (SharedArrayBuffer)");
  await ev(pageSide);
  await ev(notebook);
  await ev(terminal);

  // ---- a notebook's worker
  await ev(`nb.start([["/nb/other.py", "X = 0\\n"]], "/nb")`);
  let r = await ev(`nb.run(${JSON.stringify("import os\nt = os.stat('.').st_mtime_ns\nopen('made.txt', 'w').close()\nprint(os.stat('.').st_mtime_ns > t)\n")})`);
  check(r.stdout === "True\n" && r.error === null, `a notebook: a folder's mtime moves when a file is made in it (${JSON.stringify(r)})`);
  r = await ev(`nb.run(${JSON.stringify(tryImport("nbmod"))})`);
  check(r.stdout === "absent\n", `a notebook: a module not there yet is absent (${JSON.stringify(r)})`);
  await ev(`nb.put("/nb/nbmod.py", "X = 1\\n")`);
  r = await ev(`nb.run(${JSON.stringify("import nbmod\nprint(nbmod.X)\n")})`);
  check(r.stdout === "1\n" && r.error === null, `a notebook: a module the page put between two runs is found by the second (${JSON.stringify(r)})`);
  r = await ev(`nb.run(${JSON.stringify(tryImport("wmod") + "open('wmod.py', 'w').write('Y = 2\\n')\nimport wmod\nprint(wmod.Y)\n")})`);
  check(r.stdout === "absent\n2\n" && r.error === null, `a notebook: a module a run writes is found by its next import, in the same run (${JSON.stringify(r)})`);
  await ev("nb.stop()");

  // ---- a Terminal command's worker
  await ev(`put("/w/trigger.txt", "go\\n")`);
  r = await ev(`command(${JSON.stringify(tryImport("lmod") + "open('/w/lmod.py', 'w').write('W = 4\\n')\nimport lmod\nprint(lmod.W)\n")})`);
  check(r.code === 0 && r.stdout === "absent\n4\n", `a Terminal command: a module it writes is found by its next import (${JSON.stringify({ code: r.code, out: r.stdout, err: r.stderr?.slice(-200) })})`);
  r = await ev(`command(${JSON.stringify(tryImport("tmod") + "open('/w/trigger.txt').read()\n" + tryImport("tmod", "still absent") + "import importlib\nimportlib.invalidate_caches()\nimport tmod\nprint(tmod.Z)\n")}, { "/w/trigger.txt": ["/w/tmod.py", "Z = 3\\n"] })`);
  check(r.code === 0 && r.stdout === "absent\nstill absent\n3\n", `a Terminal command: a module the page adds while it runs is found after importlib.invalidate_caches(), not before (${JSON.stringify({ code: r.code, out: r.stdout, err: r.stderr?.slice(-200) })})`);
  r = await ev(`command(${JSON.stringify("import colorsys, fractions\nprint('ok')\n")})`);
  const probes = r.log.filter(([op, p]) => op !== "list" && /^\/w\/[^/]+(\.py|\/__init__\.py)$/.test(p) && !p.startsWith("/w/trigger") && !/^\/w\/[lt]mod\.py$/.test(p));
  const lists = r.log.filter(([op, p]) => op === "list" && p === "/w").length;
  check(r.code === 0 && r.stdout === "ok\n" && probes.length === 0 && lists === 1, `a Terminal command: library imports ask the page nothing about names the folder doesn't have (one listing of /w: ${lists}; probes: ${JSON.stringify(probes.slice(0, 6))})`);
} catch (e) {
  check(false, "threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  serve.kill();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
