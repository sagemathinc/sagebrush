// ci: web-browser/terminal.4 order=60 chrome
// The app's self-test logs its page's response headers (web/index.html, the block after "selftest_file") from a fetch
// of the page itself, and must not leave that body unread.  The app's server (tauri-plugin-localhost, tiny_http)
// answers one request at a time and writes each body in full before the next: a body the page never reads stops
// being taken in once the loopback buffers are full, and the server waits there, holding every later request.  On
// Windows, whose buffers are small, the 940 KB page was enough: the self-test module's import timed out at 15 s
// (#1025's Windows self-test).  Here a server that answers the same way, and a page large enough to fill Linux's
// buffers too, run that block as web/index.html has it: the module it then imports must load.  The block with its
// body cancel taken out is the control: its import must still be waiting when the bound ends (without the cancel,
// as on master before it, the first case fails).  Each page also says, to a second server, what the block's
// diagnosis (window.__sbSelftestHeld, which selftest() logs only when the import times out) says at the bound: the
// control's page fetch answered with its body never read, the block's own read or cancelled.
//   CHROME=google-chrome node web/test-app-headers-fetch.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
const BOUND = 5000;
const PAD = 64 << 20;
let failures = 0;
const ok = (c, what) => { console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };
setTimeout(() => { console.log("FAIL the test did not end within 90 s"); process.exit(1); }, 90_000).unref();

// (the block, as the page has it: from its first line to the line that closes it)
const START = 'if (TAURI) TAURI.core.invoke("selftest_file").then((st) => {';
const from = html.indexOf(START), to = html.indexOf("\n});\n", from);
const block = from < 0 || to < 0 ? "" : html.slice(from, to + 4);
ok(block.includes("fetch(location.href)"), "web/index.html's self-test block, with its fetch of the page, is found");
const CANCEL = " r.body?.cancel().catch(() => {});";
const control = block.replace(CANCEL, "");
ok(control !== block, "the block cancels the body of that fetch (the control takes the cancel out)");

// A server that answers as the app's does: one request at a time, in order, each body written in full (to the
// socket's end, or until the client goes) before the next request is looked at
const serve = (page) => new Promise((resolve) => {
  const queue = [], seen = [];
  let busy = false;
  const pump = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const { sock, path } = queue.shift();
      const body = path === "/" ? page : path === "/mod.js" ? Buffer.from("export const loaded = true;") : Buffer.alloc(0);
      const type = path === "/mod.js" ? "text/javascript" : "text/html";
      await new Promise((done) => {
        if (sock.destroyed) return done();
        sock.once("close", done);
        sock.write(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: ${type}\r\nContent-Length: ${body.length}\r\nCache-Control: no-cache\r\n\r\n`), body]), () => { sock.off("close", done); done(); });
      });
      seen.push({ path, at: Date.now() });
    }
    busy = false;
  };
  const server = createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      for (let i; (i = buf.indexOf("\r\n\r\n")) >= 0; buf = buf.slice(i + 4)) queue.push({ sock, path: buf.slice(0, i).split(" ")[1] });
      pump();
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/` }));
});

// what each page's diagnosis says, sent to a server of its own (the page's may be held)
const said = [];
const reports = httpServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { if (req.method === "POST") said.push(b); res.end(); }); });
await new Promise((r) => reports.listen(0, "127.0.0.1", r));
const REPORT = `http://127.0.0.1:${reports.address().port}/`;

// the page: the app's bridge stood in for, the block, then the module's import 300 ms later, bounded; padded past
// the loopback buffers.  Before the import, one small resource from the report server, ended before the import
// begins; at the bound, the block's diagnosis for that import goes to the report server
const pageWith = (b) => Buffer.concat([Buffer.from(`<!doctype html><script>
const TAURI = { core: { invoke: async (c) => (c === "selftest_file" ? "selftest.ipynb" : null) } };
${b}
setTimeout(async () => {
  await fetch(${JSON.stringify(REPORT + "early")}, { mode: "no-cors" }).then((r) => r.blob());
  const at = performance.now();
  const r = await Promise.race([import("/mod.js").then((m) => (m.loaded ? "loaded" : "empty")), new Promise((ok) => setTimeout(() => ok("waiting"), ${BOUND}))]);
  navigator.sendBeacon(${JSON.stringify(REPORT)}, JSON.stringify(window.__sbSelftestHeld?.(at) ?? null));
  fetch("/result?" + r);
}, 300);
</script><!--`), Buffer.alloc(PAD, 0x2e), Buffer.from("-->")]);

// one page in its own Chrome: the paths the server answered, once the page's result is answered or BOUND + 3 s after
// the page's first answer
const run = async (b) => {
  const { server, seen, url } = await serve(pageWith(b));
  // (the reports so far: this page's may come before its first answer is written in full, as its script runs first)
  const n = said.length;
  const profile = mkdtempSync(join(tmpdir(), "sb-headers-fetch-"));
  const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", `--user-data-dir=${profile}`, url], { stdio: "ignore", detached: true });
  const t0 = Date.now();
  while (!seen.length && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 100));
  const t1 = Date.now();
  while (!(seen.some((s) => s.path.startsWith("/result")) && said.length > n) && Date.now() - t1 < BOUND + 3000) await new Promise((r) => setTimeout(r, 100));
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  server.close();
  rmSync(profile, { recursive: true, force: true });
  return { paths: seen.map((s) => s.path), held: said.length > n ? JSON.parse(said.at(-1)) : null, url };
};

const fixed = await run(block);
ok(fixed.paths.includes("/result?loaded"), "the module the page imports after the block loads: " + JSON.stringify(fixed.paths.slice(0, 6)));
const held = await run(control);
ok(held.paths[0] === "/" && !held.paths.includes("/mod.js"), "the control (the body left unread) holds the server, the import's request with it: " + JSON.stringify(held.paths.slice(0, 6)));
// (the diagnosis: the page's own fetch, answered, its body never read in the control and cancelled in the block)
const page = (h, u) => (h ?? []).find((l) => l.startsWith(`fetch ${u}: began `)) ?? "";
ok(/^the import began at \d+ ms$/.test(held.held?.[0] ?? "") && / answered \d+ ms \(200\), body never read$/.test(page(held.held, held.url)),
  "the control's diagnosis names the page's fetch, answered and its body never read: " + JSON.stringify(held.held));
ok(/ answered \d+ ms \(200\), body read or cancelled$/.test(page(fixed.held, fixed.url)), "the block's diagnosis has that fetch's body cancelled: " + JSON.stringify(fixed.held));
// (the resources that were loading when the import began and have ended since: the block's page fetch is one; the
// control's, never ended, is not, as a timing entry appears only once a resource has ended)
const res = (h, u) => (h ?? []).some((l) => new RegExp(`^resource ${u.replace(/[.]/g, "\\.")}: began \\d+ ms, first byte \\d+ ms, ended \\d+ ms, \\d+ B$`).test(l));
ok(res(fixed.held, fixed.url) && !res(held.held, held.url), "a resource loading when the import began is listed once it has ended, and not before");
ok(![...(fixed.held ?? []), ...(held.held ?? [])].some((l) => l.startsWith(`resource ${REPORT}early`)), "a resource that ended before the import began is not listed");
// (selftest() says the diagnosis only when the import has timed out: on success, nothing more is logged)
ok(/catch \(e\) \{\n\s*console\.log\("diagnose import: " \+ e\);\n(\s*\/\/.*\n)?\s*if \(\/\^timed out\/\.test\(e\?\.message \?\? ""\)\) for \(const l of window\.__sbSelftestHeld\?\.\(importAt\)/.test(html),
  "selftest() logs the diagnosis only in its catch, and only for a timeout");
ok(html.split("__sbSelftestHeld").length === 3, "the diagnosis is defined once and used there only");
reports.close();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
