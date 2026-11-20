// ci: web-sync-ops order=22 runner=bun chrome
// The desktop app's workspace on disk across the pages of one launch (web/workspace/disk-mirror.ts diskWorkspace, with
// its IndexedDB record of the disk, idbState), through real navigation, in headless Chromium: the disk is this test's
// server's (a disk in memory with disk.rs's verbs and checks, reached as the app's IPC is), so it outlives each page.
//   1. the launch's first page imports the disk, a save is written through, and leaving waits for the record;
//   2. another program changes the file; the next page (a navigation) brings the change in, the disk winning, and a
//      save made on it is written normally (control: unchanged, nothing brought in);
//   3. a conflict's copy on one page is still where that file's saves go on the next;
//   4. the record held: leaving the page waits for it, and says it within the deadline; the record failing: said.
//   CHROME=google-chrome bun web/workspace/test-disk-nav.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-nav-site-"));
const built = await Bun.build({ entrypoints: [join(here, "disk-mirror-entry.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) { console.error(built.logs.join("\n")); process.exit(1); }
// (the page: the launch's workspace (one IndexedDB, kept across its navigations), its disk through /disk)
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>disk navigation test</title><script type="module">
import * as W from "./ws.js";
window.W = W;
window.invoke = async (cmd, args, opts) => {
  const body = args instanceof Uint8Array ? args : new TextEncoder().encode(JSON.stringify({ cmd, args }));
  const r = await fetch("/disk?cmd=" + cmd, { method: "POST", body, headers: { ...(opts?.headers ?? {}), "x-args": args instanceof Uint8Array ? "" : "json" } });
  if (!r.ok) throw new Error(await r.text());
  return cmd === "disk_read" ? new Uint8Array(await r.arrayBuffer()) : r.json();
};
window.open_ = async () => { const ws = await W.Workspace.open({ name: "ws-nav", mainName: "main-nav" }); const m = await W.diskWorkspace(ws, window.invoke); window.ws = ws; window.m = m; return true; };
window.ready = true;
</script>`);

// ---- the disk: files by workspace path, each {bytes, mtime}; disk.rs's checks
const files = new Map(), dirs = new Set(["/"]);
let clock = 1000;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const st = (p) => (files.has(p) ? { path: p, dir: false, size: files.get(p).bytes.length, mtime: files.get(p).mtime, sha256: sha(files.get(p).bytes) } : dirs.has(p) ? { path: p, dir: true, size: 0, mtime: 0 } : null);
const holds = (x, p) => { const s = st(p); if (!x || x === "any") return true; if (x === "absent") return !s; const [size, mtime, h] = x.split(":"); return !!s && !s.dir && s.size === +size && s.mtime === +mtime && s.sha256 === h; };
const parentOf = (p) => p.slice(0, Math.max(1, p.lastIndexOf("/")));
const mk = (p) => { while (p !== "/" && !dirs.has(p)) { dirs.add(p); p = parentOf(p); } };
const CONFLICT = "changed by another program";
const external = (p, text) => { mk(parentOf(p)); files.set(p, { bytes: Buffer.from(text), mtime: ++clock }); };
const text = (p) => files.get(p)?.bytes.toString();
const json = (v) => new Response(JSON.stringify(v ?? null), { headers: { "content-type": "application/json" } });
const err = (m) => new Response(m, { status: 500 });

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/disk") {
    const cmd = u.searchParams.get("cmd"), raw = Buffer.from(await req.arrayBuffer());
    if (cmd === "disk_write") {
      const p = decodeURIComponent(req.headers.get("sagebrush-path")), x = req.headers.get("sagebrush-expect");
      if (!holds(x, p)) return err(CONFLICT);
      mk(parentOf(p)); files.set(p, { bytes: raw, mtime: ++clock }); return json(st(p));
    }
    const { args } = JSON.parse(raw.toString() || "{}");
    switch (cmd) {
      case "disk_list": return json([...[...dirs].filter((d) => d !== "/").map(st), ...[...files.keys()].map(st)]);
      case "disk_stat": return json(st(args.path));
      case "disk_read": return files.has(args.path) ? new Response(files.get(args.path).bytes) : err("no " + args.path);
      case "disk_mkdir": mk(args.path); return json(null);
      case "disk_rename": {
        if (!files.has(args.from) && !dirs.has(args.from)) return err(args.expect === "any" ? "not there" : CONFLICT);
        if (!holds(args.expect, args.from) || st(args.to)) return err(CONFLICT);
        mk(parentOf(args.to)); files.set(args.to, files.get(args.from)); files.delete(args.from); return json(null);
      }
      case "disk_remove": { if (!holds(args.expect, args.path)) return err(CONFLICT); files.delete(args.path); return json(null); }
    }
    return err("no such command " + cmd);
  }
  const p = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
  if (!["index.html", "ws.js"].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p)), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-nav-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const results = [];
const check = (ok, what) => { results.push([!!ok, what]); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
let code = 1;
try {
  const port = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(100); }
  const cdp = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (cdp.onopen = r));
  let n = 0;
  const waiting = new Map();
  cdp.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500)); return r.result?.value; };
  const page = async () => {
    await send("Page.navigate", { url: `http://127.0.0.1:${server.port}/` });
    await sleep(200);
    for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
    return ev("window.open_()");
  };
  const keep = (ms = 5000) => ev(`W.keepAll(window.m, undefined, ${ms}).then((r) => r)`);
  const banner = () => ev("document.getElementById('sb-disk-banner')?.textContent ?? ''");
  await send("Page.enable");

  // 1. the launch's first page
  external("/nav.txt", "original");
  external("/keep.txt", "kept");
  await page();
  check((await ev("window.ws.read('/nav.txt').then((r) => new TextDecoder().decode(r.content))")) === "original", "the first page: the disk imported");
  await ev("window.ws.write('/nav.txt', new TextEncoder().encode('first'))");
  let k = await keep();
  check(k.not.length === 0 && text("/nav.txt") === "first", "a save written through, and everything kept (the record too) before leaving");

  // 2. changed outside; the next page brings it in
  external("/nav.txt", "external");
  await page();
  check((await ev("window.ws.read('/nav.txt').then((r) => new TextDecoder().decode(r.content))")) === "external" && /brought in: \/nav\.txt/.test(await banner()), "the next page (a navigation): the change outside brought in, the disk winning, and said");
  await ev("window.ws.write('/nav.txt', new TextEncoder().encode('second'))");
  k = await keep();
  check(k.not.length === 0 && text("/nav.txt") === "second" && !files.has("/nav (from Sagebrush).txt"), "a save made on it: written over it, as the person saw it");
  await page();
  check(!/brought in/.test(await banner()) && (await ev("window.ws.read('/keep.txt').then((r) => new TextDecoder().decode(r.content))")) === "kept", "the control: nothing changed outside, nothing brought in");

  // 3. a conflict's copy, then another page: that file's saves still go to the copy
  external("/nav.txt", "changed during the page");
  await ev("window.ws.write('/nav.txt', new TextEncoder().encode('third'))");
  k = await keep();
  check(text("/nav.txt") === "changed during the page" && text("/nav (from Sagebrush).txt") === "third", "a change outside during a page: kept, Sagebrush's beside it");
  await page();
  await ev("window.ws.write('/nav.txt', new TextEncoder().encode('fourth'))");
  k = await keep();
  check(text("/nav (from Sagebrush).txt") === "fourth" && text("/nav.txt") === "changed during the page", "on the next page, its saves still go to the copy (the record kept across the navigation)");

  // 4. the record held, then failing
  await ev(`(() => { const s = W.idbState.save.bind(W.idbState); window.release = null; W.idbState.save = (st) => new Promise((r) => (window.release = r)).then(() => s(st)); return true; })()`);
  await ev("window.ws.write('/keep.txt', new TextEncoder().encode('kept 2'))");
  k = await ev("W.keepAll(window.m, undefined, 300)");
  check(k.not.some((t) => /record of the files on disk: still not done/.test(t)) && k.count === 1, `the record held: leaving waits, and says so within the deadline (${JSON.stringify(k.not)})`);
  await ev("window.release && window.release(), true");
  k = await keep();
  check(k.not.length === 0, "...then kept, and the page may go");
  await ev(`(() => { W.idbState.save = () => Promise.reject(new Error("state store full")); return true; })()`);
  await ev("window.ws.write('/keep.txt', new TextEncoder().encode('kept 3'))");
  k = await ev("W.keepAll(window.m, undefined, 2000)");
  check(k.not.some((t) => /record of the files on disk: state store full/.test(t)), `the record failing: said before leaving (${JSON.stringify(k.not)})`);
  check(!(await ev("W.beforeLeave(window.m, undefined, 2000)")) && /Not saved yet/.test(await banner()), "and leaving the page refused, said on the banner");

  const fails = results.filter(([ok]) => !ok);
  console.log(fails.length ? `FAIL: ${fails.length} of ${results.length} checks` : `ok: the workspace on disk across a launch's pages, ${results.length} checks`);
  code = fails.length ? 1 : 0;
  cdp.close();
} catch (e) {
  console.error("FAIL", e?.stack ?? e);
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
