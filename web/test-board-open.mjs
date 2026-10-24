// End-to-end test of `sagebrush board open FILE` (src/board-open.ts) in headless Chromium:
//
//   node web/test-board-open.mjs [bundle]     (default build/cli/pyjs.cjs; CHROME=... for the browser)
//
// It starts the command on a board in a scratch directory and checks:
//   - its refusals: no token, another Host or port, no key or a wrong one,
//     any other path (no other file, no directory, no path escape), methods
//     other than GET and HEAD;
//   - the page: sandboxed, with the frame's policy and no framing;
//   - the board shown, its code item run in the page;
//   - the file rewritten: shown again in place (the same page, its camera
//     kept);
//   - a rewrite that isn't a board (half written), a file too large, a file
//     deleted: the last good version still shown, with a bar saying why,
//     until the file is a board again;
//   - connections bounded, in number (any route, event streams among them) and in how long headers take;
//   - Ctrl-C stops it.
import { spawn } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, writeFileSync, renameSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const bundle = process.argv[2] ?? new URL("../build/cli/pyjs.cjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };

const dir = mkdtempSync(join(tmpdir(), "sb-board-open-"));
const file = join(dir, "talk.board.json");
writeFileSync(join(dir, "secret.txt"), "not for the page\n");
const board = (title, notes, code = "print(6 * 7)") => JSON.stringify({ format: "sagebrush-board", version: 1, title, nodes: [...notes.map((t, i) => ({ id: "n" + i, text: t, x: 40, y: 40 + 140 * i })), { id: "c", code, x: 400, y: 40 }] });
// (written as an agent does: the whole file at once, by rename)
const rewrite = (text) => { writeFileSync(file + ".tmp", text); renameSync(file + ".tmp", file); };
rewrite(board("First", ["alpha note"]));

const port = await freePort();
const server = spawn(process.execPath, [bundle, "board", "open", file, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "inherit"] });
let printed = "";
server.stdout.on("data", (d) => (printed += d));
for (let i = 0; i < 100 && !/token=/.test(printed); i++) await sleep(100);
const url = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+)/.exec(printed);
ok(!!url, "the command prints its URL with a token");
const at = Number(url?.[1] ?? port), token = url?.[2] ?? "";
const base = `http://127.0.0.1:${at}`;

// ---- refusals, over plain HTTP
const get = (p, o = {}) => fetch(base + p, { redirect: "manual", ...o });
const cookie = `sagebrush_board_${at}=${token}`;
// (with a Host of its own: fetch() sends its URL's, whatever it is given)
const raw = (p, headers) => new Promise((r) => request({ host: "127.0.0.1", port: at, path: p, headers }, (res) => { res.resume(); r(res.statusCode); }).on("error", () => r(0)).end());
ok((await get("/")).status === 403, "no page without the token");
ok((await get("/", { headers: { Cookie: `sagebrush_board_${at}=${"0".repeat(48)}` } })).status === 403, "...or with another token");
ok((await raw(`/?token=${token}`, { Host: "evil.example" })) === 403 && (await raw(`/?token=${token}`, { Host: `evil.example:${at}` })) === 403, "another host name is refused (DNS rebinding)");
ok((await raw(`/?token=${token}`, { Host: `127.0.0.1:${at + 1}` })) === 403 && (await raw(`/?token=${token}`, { Host: "127.0.0.1" })) === 403, "...and another port, or none");
ok((await raw(`/?token=${token}`, { Host: `localhost:${at}` })) === 302 && (await raw(`/?token=${token}`, { Host: `127.0.0.1:${at}` })) === 302, "...while its own host and port are answered");
const traded = await get(`/?token=${token}`);
ok(traded.status === 302 && traded.headers.get("location") === "/" && (traded.headers.get("set-cookie") ?? "").includes(cookie) && /HttpOnly/.test(traded.headers.get("set-cookie")) && /SameSite=Strict/.test(traded.headers.get("set-cookie")), "the token is traded for a cookie (HttpOnly, SameSite=Strict) and dropped from the address");
const pageRes = await get("/", { headers: { Cookie: cookie } });
const page = await pageRes.text();
const csp = pageRes.headers.get("content-security-policy") ?? "";
ok(pageRes.status === 200 && /data-sb-from="local"/.test(page), "the page, with the cookie");
ok(/\bsandbox allow-scripts\b/.test(csp) && !/allow-same-origin/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/frame-ancestors \*/.test(csp), "the page is sandboxed (an opaque origin) and can't be framed: " + csp.slice(0, 80));
const key = /id="sb-local">(\{.*?\})<\/script>/.exec(page)?.[1] && JSON.parse(/id="sb-local">(\{.*?\})<\/script>/.exec(page)[1]).key;
ok(typeof key === "string" && key !== token, "the page has a key of its own (not the token)");
ok((await get("/board")).status === 403 && (await get("/board?key=" + "0".repeat(48))).status === 403 && (await get("/events?key=nope")).status === 403, "the file's text and changes need the page's key");
ok((await get("/board?key=" + key, { headers: { Origin: `http://127.0.0.1:${at + 1}` } })).status === 403 && (await get("/events?key=" + key, { headers: { Origin: "http://evil.example" } })).status === 403, "...and come from the page only (another port's or site's Origin refused)");
const text = await get("/board?key=" + key);
ok(text.status === 200 && (await text.text()) === board("First", ["alpha note"]) && /^[0-9a-f]{64}$/.test(text.headers.get("x-sagebrush-revision") ?? ""), "the file's text, exactly, and its revision");
for (const p of ["/secret.txt", "/talk.board.json", "/tree/", "/frame/board/index.html", "/_headers", "/board/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/engine/0123456789abcdef0123/manifest.json", "/engine/x/../../secret.txt", "//etc/passwd", "/index.html"])
  ok([403, 404].includes((await get(p, { headers: { Cookie: cookie } })).status), `nothing else is served: ${p}`);
ok((await get("/", { method: "POST", headers: { Cookie: cookie } })).status === 405 && (await get("/board?key=" + key, { method: "PUT", body: "x" })).status === 405, "only GET and HEAD");

// ---- connections bounded, whatever they ask for (daybreak2's LIM-BOARDOPEN-1): 64 at once, those that never
// send their headers among them, the 65th closed; then room again
{
  const MAX = 64;
  const open = (n) => Promise.all(Array.from({ length: n }, () => new Promise((r) => { const s = connect(at, "127.0.0.1", () => r(s)); s.on("error", () => r(s)); })));
  const idle = await open(MAX);
  await sleep(300);
  // (on a connection of its own: fetch() would reuse one it already has)
  const refused = (p) => new Promise((r) => {
    const q = request({ host: "127.0.0.1", port: at, path: p, agent: false, timeout: 3000 }, (res) => { res.resume(); r(false); });
    q.on("error", () => r(true)).on("timeout", () => { q.destroy(); r(true); }).end();
  });
  ok(await refused("/board?key=" + key) && await refused("/"), `with ${MAX} connections open (none past its headers), another is closed, on any route`);
  // (some kept as event streams: they count too)
  for (const s of idle.slice(0, 32)) s.destroy();
  await sleep(300);
  const streams = await Promise.all(Array.from({ length: 16 }, () => new Promise((r) => request({ host: "127.0.0.1", port: at, path: "/events?key=" + key, agent: false }, (res) => r(res)).on("error", () => r(null)).end())));
  ok(streams.every((x) => x && x.statusCode === 200), "16 pages following the file, beside 32 idle connections");
  const more = await open(16);
  await sleep(300);
  ok(await refused("/board?key=" + key), "...and those 48 with 16 more make 64: the next is closed");
  for (const s of [...idle, ...more]) s.destroy();
  for (const r of streams) r?.destroy();
  await sleep(500);
  ok((await get("/board?key=" + key)).status === 200, "once they close, requests are answered again");
  // (a connection that never finishes its headers is answered 408 and closed, after HEADERS_MS; tried again if
  // it was refused at once, while the connections closed above were still being counted)
  const slowOnce = () => new Promise((r) => {
    const t0 = Date.now(), c = connect(at, "127.0.0.1");
    let got = "";
    c.on("data", (d) => (got += d));
    c.on("error", () => {});
    c.on("connect", () => c.write("GET / HTTP/1.1\r\nHost: 127.0.0.1:" + at + "\r\n"));
    c.on("close", () => r({ ms: Date.now() - t0, got }));
    setTimeout(() => { c.destroy(); r({ ms: Infinity, got }); }, 20000);
  });
  let slow = await slowOnce();
  for (let i = 0; i < 5 && !slow.got && slow.ms < 1000; i++) { await sleep(1000); slow = await slowOnce(); }
  ok(/^HTTP\/1\.1 408/.test(slow.got) && slow.ms < 15000, `a connection whose headers never end is answered 408 and closed: after ${slow.ms} ms`);
}

// ---- in Chromium
const profile = mkdtempSync(join(tmpdir(), "sb-board-open-chrome-"));
let cdpPort = Number(process.env.CDP_PORT) || 0;
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!cdpPort) cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
// (the profile removed once Chrome has exited, which writes to it on its way out)
const cleanup = async () => {
  try { ws.close(); } catch {}
  const gone = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  server.kill();
  await Promise.race([gone, sleep(5000)]);
  for (const d of [dir, profile]) try { rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
};
process.on("uncaughtException", async (e) => { console.log("FAIL " + (e?.stack ?? e)); await cleanup(); process.exit(1); });
process.on("unhandledRejection", async (e) => { console.log("FAIL " + (e?.stack ?? e)); await cleanup(); process.exit(1); });

const shown = (t) => `document.body.innerText.includes(${JSON.stringify(t)})`;
const bar = "document.getElementById('sbb-local')?.textContent ?? ''";
await send("Page.navigate", { url: url[0] });
ok(await until(shown("alpha note")), "the board is shown");
ok(await ev("location.href") === base + "/" && await ev("(() => { try { return localStorage.length, false; } catch { return true; } })()"), "...at /, the token gone from the address, in an opaque origin (no storage)");
ok(await until(shown("42"), 120000), "its code item runs in the page");
// (read only, and saying so: Edit shown but not allowed, with how to change the board, on it and in the caption)
ok(await ev("(() => { const b = document.querySelector('[data-sbb=edit]'); return !!b && !b.hidden && b.disabled && /^Read only: .*change the file/.test(b.title); })()"), "Edit isn't allowed (the file is the board's only copy), and says why and how to change the board");
ok(await ev("document.body.textContent.includes('Read only: this page follows the board')"), "...which the page says too");

// the file rewritten: shown in place, the camera kept
await ev("window.__sameDocument = 1, window.board.setCamera({ x: 123, y: 45, z: 1.25 })");
rewrite(board("Second", ["alpha note", "beta note"]));
ok(await until(shown("beta note"), 10000), "a rewrite is shown");
ok(await ev("window.__sameDocument === 1"), "...in place (the page wasn't reloaded)");
ok(await ev("(() => { const c = window.board.camera; return Math.abs(c.x - 123) < 1 && Math.abs(c.y - 45) < 1 && Math.abs(c.z - 1.25) < 1e-6; })()"), "...with the camera where it was: " + JSON.stringify(await ev("window.board.camera")));
ok(await ev(`!(${bar})`), "...and no bar");

// half written: the last good version stays, said
rewrite('{"format": "sagebrush-board", "version": 1, "nodes": [{"id": "n0", "text": "gam');
ok(await until(`(${bar}).includes("isn't a board right now")`, 10000), "a half-written file: a bar says so: " + (await ev(bar)).slice(0, 120));
ok(await ev(shown("beta note")) && await ev("window.__sameDocument === 1"), "...and the last good version is still shown");
rewrite(board("Third", ["gamma note"]));
ok(await until(`${shown("gamma note")} && !(${bar})`, 10000), "a good version again: shown, the bar gone");

// too large: never read past the cap
truncateSync(file, 128 * 2 ** 20 + 1);
ok(await until(`(${bar}).includes("too large")`, 15000), "a file larger than the board opens: said, not read: " + (await ev(bar)).slice(0, 120));
ok(await ev(shown("gamma note")), "...the last good version still shown");
// deleted, then back
rmSync(file);
ok(await until(`(${bar}).includes("no such file")`, 10000), "the file deleted: said");
rewrite(board("Fourth", ["delta note"]));
ok(await until(`${shown("delta note")} && !(${bar})`, 10000), "the file back: shown");
ok(await ev("window.__sameDocument === 1"), "...all in the same page");

// many rewrites at once: the page ends on the last one
for (let i = 0; i < 40; i++) rewrite(board("Burst", ["burst " + i]));
ok(await until(`${shown("burst 39")} && !${shown("burst 38")}`, 10000), "forty rewrites in a row: the page ends on the last");

// Ctrl-C stops it
const exited = new Promise((r) => server.once("exit", (code, sig) => r({ code, sig })));
server.kill("SIGINT");
const how = await Promise.race([exited, sleep(5000).then(() => null)]);
ok(how && how.code === 0, "Ctrl-C stops it: " + JSON.stringify(how));
ok(await until(`(${bar}).includes("isn't answering")`, 10000), "...and the page says it isn't following the file any more");

await cleanup();
console.log(failures ? `${failures} failures` : "all passed");
process.exit(failures ? 1 : 0);
