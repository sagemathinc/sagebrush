// ci: web-runner order=115 chrome
// Renaming a notebook of `sagebrush notebook DIR` (src/notebook.ts; William's B2), in headless Chromium: its title is
// its file's name, so editing the title renames the FILE, to a free name beside it (" (2)" when the name is taken:
// never over another file), and then the page's address and its "saved to" say the new name; later saves go there,
// and the file opens again at its new address; a rename held back serializes with the saves (LOCAL-RENAME-2); a symbolic
// link out of DIR is refused (LOCAL-RENAME-1). And the server's api/rename refuses what it must (fs-move.ts: test/fs-move.test.ts).
//   node web/test-local-rename.mjs [bundle]     (default build/cli/pyjs.cjs; CHROME=... for the browser)
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort, freePort } from "./test-port.mjs";

const bundle = process.argv[2] ?? new URL("../build/cli/pyjs.cjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, count = 0;
const ok = (cond, name) => { count++; console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failures++; };

const dir = mkdtempSync(join(tmpdir(), "sb-local-rename-"));
mkdirSync(join(dir, "sub"));
// (a notebook already called "stats": the rename must not overwrite it)
const STATS = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", source: "print('the other stats')", metadata: {}, outputs: [], execution_count: null }] });
writeFileSync(join(dir, "stats.ipynb"), STATS);
const port = await freePort();
const server = spawn(process.execPath, [bundle, "notebook", dir, "--port", String(port), "--no-browser"], { stdio: ["ignore", "pipe", "inherit"] });
let printed = "";
server.stdout.on("data", (d) => (printed += d));
for (let i = 0; i < 100 && !/token=/.test(printed); i++) await sleep(100);
const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/.exec(printed)?.[0];
ok(!!url, "the server prints its URL with a token");
const base = `http://127.0.0.1:${port}`, token = /token=(\w+)/.exec(url ?? "")?.[1], cookie = `sagebrush_token=${token}`;

const profile = mkdtempSync(join(tmpdir(), "sb-local-rename-chrome-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdpPort = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
const paused = [], pausedUrls = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.method === "Fetch.requestPaused") { paused.push(m.params.requestId); pausedUrls.push(m.params.request.url); } if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 30000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
const go = async (u) => { await send("Page.navigate", { url: u }); await sleep(800); return until("document.querySelector('#status')?.textContent.startsWith('ready') && !!document.querySelector('#cells textarea')", 60000); };
const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null);
const rename = (title) => ev(`(() => { const t = document.querySelector("#nbname"); t.value = ${JSON.stringify(title)}; t.dispatchEvent(new Event("input")); return true; })()`);
const setCode = (code) => ev(`(() => { const c = sagebrush.notebook.cells()[0]; sagebrush.notebook.setInput(c, ${JSON.stringify(code)}); sagebrush.notebook.flush?.(); return true; })()`);

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url }); await sleep(500);
  ok(await go(`${base}/nb/Untitled.ipynb/`), "a new notebook, Untitled.ipynb, opens");
  await setCode("x = 'mine'");
  ok(await until(`/saved to Untitled\\.ipynb/.test(document.querySelector("#saved").textContent)`, 20000) && (read("Untitled.ipynb") ?? "").includes("x = 'mine'"), "…saved to Untitled.ipynb on disk");

  // the title to a name that's taken: the file renamed to the free "stats (2).ipynb", the other one untouched
  await rename("stats");
  ok(await until(`location.pathname === "/nb/stats%20(2).ipynb/"`, 15000), `the address follows: ${await ev("location.pathname")}`);
  ok(read("Untitled.ipynb") === null && (read("stats (2).ipynb") ?? "").includes("x = 'mine'"), "the FILE is renamed: Untitled.ipynb is gone, stats (2).ipynb holds the notebook");
  ok(read("stats.ipynb") === STATS, "…and the stats.ipynb already there is untouched (never overwritten)");
  ok(await until(`/saved to stats \\(2\\)\\.ipynb/.test(document.querySelector("#saved").textContent)`, 10000), `the caption says the new name: ${await ev(`document.querySelector("#saved").textContent`)}`);
  ok(/stats \(2\)\.ipynb/.test(await ev("document.title")), "…and the tab's title");

  // later saves go to the new file; it opens again at its new address
  await setCode("x = 'mine, edited'");
  ok(await until(`/saved to stats \\(2\\)\\.ipynb/.test(document.querySelector("#saved").textContent)`, 20000) && (await (async () => { for (let i = 0; i < 100; i++) { if ((read("stats (2).ipynb") ?? "").includes("mine, edited")) return true; await sleep(100); } return false; })()), "a later edit is saved to stats (2).ipynb");
  ok(read("Untitled.ipynb") === null && read("stats.ipynb") === STATS, "…and nothing else is written");
  ok(await go(`${base}/nb/stats%20(2).ipynb/`) && /mine, edited/.test(await ev(`sagebrush.notebook.cells()[0].ta.value`)), "the notebook opens again at its new address");

  // a free name: the file takes it exactly
  await rename("fresh");
  ok(await until(`location.pathname === "/nb/fresh.ipynb/"`, 15000) && read("stats (2).ipynb") === null && (read("fresh.ipynb") ?? "").includes("mine, edited"), "a free name: stats (2).ipynb renamed to fresh.ipynb");

  // (astra's LOCAL-RENAME-2) the rename's answer held back while the notebook is edited: the edit's save waits for the
  // rename and goes to the new name; the old name is never written again, the new file has the newest edit
  await send("Fetch.enable", { patterns: [{ urlPattern: "*api/rename*", requestStage: "Request" }] });
  await rename("held");
  for (let i = 0; i < 100 && !paused.length; i++) await sleep(100);
  ok(paused.length === 1, "(the rename's request is held)");
  await setCode("x = 'edited during the rename'");
  await sleep(2500);
  ok((read("fresh.ipynb") ?? "").includes("mine, edited") && !(read("fresh.ipynb") ?? "").includes("during the rename") && read("held.ipynb") === null, "while the rename is held, the edit isn't written to the old name (its save waits)");
  await send("Fetch.continueRequest", { requestId: paused.shift() });
  await send("Fetch.disable");
  ok(await until(`location.pathname === "/nb/held.ipynb/"`, 15000), "the rename lands: /nb/held.ipynb/");
  ok(await (async () => { for (let i = 0; i < 100; i++) { if ((read("held.ipynb") ?? "").includes("during the rename")) return true; await sleep(100); } return false; })() && read("fresh.ipynb") === null, "…the edit made during it is saved to held.ipynb, and fresh.ipynb isn't made again");

  // (astra's LOCAL-RENAME-3 recovery) a rename answered "exists" tries the next name; one answered "kept" (another program
  // made both names meanwhile; the file as it was left at its staging name) stops there: no other name tried, the
  // staging name said, and nothing more saved from this page
  const fulfill = (id, status, body) => send("Fetch.fulfillRequest", { requestId: id, responseCode: status, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*api/rename*", requestStage: "Request" }] });
  paused.length = 0; pausedUrls.length = 0;
  await rename("again");
  for (let i = 0; i < 100 && !paused.length; i++) await sleep(100);
  await fulfill(paused.shift(), 409, { code: "exists", message: "a file of that name is there" });
  for (let i = 0; i < 100 && !paused.length; i++) await sleep(100);
  ok(pausedUrls.length === 2 && /to=again%20\(2\)\.ipynb/.test(pausedUrls[1]), `"exists": the next name is tried (${pausedUrls.map((u) => decodeURIComponent(u.split("to=")[1] ?? "")).join(", ")})`);
  await send("Fetch.continueRequest", { requestId: paused.shift() });
  ok(await until(`location.pathname === "/nb/again%20(2).ipynb/"`, 15000), "…and taken");
  const before = read("again (2).ipynb");
  paused.length = 0; pausedUrls.length = 0;
  await rename("kept here");
  for (let i = 0; i < 100 && !paused.length; i++) await sleep(100);
  // (a second title edit while the first rename is held: its rename task is queued behind it, and must refuse when it
  // runs after "kept": astra on e9d8a754)
  await rename("queued behind");
  await sleep(1500);
  await fulfill(paused.shift(), 409, { code: "kept", message: "kept as .again (2).ipynb.sagebrush-rename-0123456789ab", stage: ".again (2).ipynb.sagebrush-rename-0123456789ab" });
  await sleep(1500);
  ok(pausedUrls.length === 1, `"kept": no other name is tried, and the rename queued behind it does nothing (${pausedUrls.length} request)`);
  ok(/kept as \.again \(2\)\.ipynb\.sagebrush-rename-0123456789ab/.test(await ev(`document.querySelector("#status").textContent`)) && (await ev("location.pathname")) === "/nb/again%20(2).ipynb/", "…the page says where the file is kept, and stays at its address");
  await setCode("x = 'after kept'");
  await sleep(2500);
  ok(read("again (2).ipynb") === before && !(read("kept here.ipynb") ?? "").length && /not saved/.test(await ev(`document.querySelector("#saved").textContent`)), "…and saves nothing more (an edit after it isn't written anywhere)");
  // (astra on e9d8a754) another title edit after "kept", and a rename already queued when it came: no rename request
  // more, the address and every file left as they are
  const filesNow = () => readdirSync(dir).filter((f) => f.endsWith(".ipynb")).sort().join(",");
  const filesBefore = filesNow();
  paused.length = 0; pausedUrls.length = 0;
  await rename("another title");
  await sleep(2500);
  ok(pausedUrls.length === 0 && (await ev("location.pathname")) === "/nb/again%20(2).ipynb/" && filesNow() === filesBefore, `another title edit after "kept": no rename request, the address and the files as they were (${pausedUrls.length} requests)`);

  await send("Fetch.disable");
  // (the route says which: a taken name is code "exists")
  writeFileSync(join(dir, "c.ipynb"), "{}"); writeFileSync(join(dir, "d.ipynb"), "{}");
  const taken = await fetch(`${base}/api/rename?path=c.ipynb&to=d.ipynb`, { method: "POST", headers: { Cookie: cookie } });
  ok(taken.status === 409 && (await taken.json()).code === "exists", "api/rename: a taken name answers code \"exists\"");

  // (astra's LOCAL-RENAME-1) a folder that is a symbolic link out of DIR, or a notebook that is one: refused, nothing moved
  const outside = mkdtempSync(join(tmpdir(), "sb-local-rename-outside-"));
  writeFileSync(join(outside, "a.ipynb"), "OUTSIDE");
  symlinkSync(outside, join(dir, "jump"));
  symlinkSync(join(outside, "a.ipynb"), join(dir, "link.ipynb"));
  const post = (q) => fetch(`${base}/api/rename?${q}`, { method: "POST", headers: { Cookie: cookie } }).then((r) => r.status);
  ok((await post("path=jump/a.ipynb&to=jump/b.ipynb")) === 400 && readFileSync(join(outside, "a.ipynb"), "utf8") === "OUTSIDE" && !existsSync(join(outside, "b.ipynb")), "api/rename: in a folder that is a symbolic link out of DIR: 400, the file outside untouched");
  ok((await post("path=link.ipynb&to=link2.ipynb")) === 400 && existsSync(join(dir, "link.ipynb")) && !existsSync(join(dir, "link2.ipynb")), "…a notebook that is a symbolic link: 400, left as it is");
  rmSync(outside, { recursive: true, force: true });

  // the server's api/rename: what it refuses
  const api = (q, method = "POST") => fetch(`${base}/api/rename?${q}`, { method, headers: { Cookie: cookie } }).then((r) => r.status);
  writeFileSync(join(dir, "a.ipynb"), "{}");
  writeFileSync(join(dir, "b.ipynb"), "{}");
  ok((await api("path=a.ipynb&to=b.ipynb")) === 409 && read("a.ipynb") === "{}" && read("b.ipynb") === "{}", "api/rename: onto a file that exists is 409, both left as they were");
  ok((await api("path=a.ipynb&to=sub/a.ipynb")) === 400, "…into another folder: 400");
  ok((await api("path=a.ipynb&to=a.txt")) === 400 && (await api("path=a.txt&to=c.ipynb")) === 400, "…from or to a name that isn't .ipynb: 400");
  ok((await api("path=a.ipynb&to=../evil.ipynb")) === 400 && (await api("path=../x.ipynb&to=y.ipynb")) === 400, "…outside DIR: 400");
  ok((await api("path=a.ipynb&to=c.ipynb", "GET")) === 405, "…not POST: 405");
  ok((await fetch(`${base}/api/rename?path=a.ipynb&to=c.ipynb`, { method: "POST" }).then((r) => r.status)) === 403 && read("a.ipynb") === "{}", "…without the token: 403, nothing moved");
  ok((await fetch(`${base}/api/rename?path=a.ipynb&to=c.ipynb`, { method: "POST", headers: { Cookie: cookie, Origin: "http://evil.example" } }).then((r) => r.status)) === 403, "…from another origin: 403");
  const r = await fetch(`${base}/api/rename?path=nope.ipynb&to=nope2.ipynb`, { method: "POST", headers: { Cookie: cookie } });
  ok(r.status === 200 && JSON.stringify(await r.json()) === '{"path":"nope2.ipynb","moved":false}' && read("nope2.ipynb") === null, "…a notebook not saved yet: only the name is checked free, nothing made");
} catch (e) {
  ok(false, "threw: " + String(e?.stack ?? e).slice(0, 600));
} finally {
  const gone = chrome.exitCode !== null ? Promise.resolve() : new Promise((r) => chrome.once("exit", r));
  chrome.kill(); server.kill();
  await Promise.race([gone, sleep(5000)]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
