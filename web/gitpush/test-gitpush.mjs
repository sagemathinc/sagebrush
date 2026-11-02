// "Push project to GitHub" (Stage A MVP r1 §1; web/gitpush), end to end in headless Chromium against the built site
// (bun web/build.ts first): the Storage panel's section, offered only with the flag; the token saved in the worker
// and never in the page; a folder pushed through a stand-in for the push proxy (the same /github.com/<owner>/<repo>.git
// routes as web/gitpush/worker.mjs) to a real git server (git http-backend), its files as the rules say (notebooks
// without outputs, .sagebrush never, nothing outside the folder); a second push with a change and a removal; a branch
// moved on the server refused, never overwritten; a wrong token refused in fixed words; Forget token.
//   node web/gitpush/test-gitpush.mjs        (CHROME=… to choose the browser)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { devtoolsPort } from "../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "sb-gitpush-"));
const TOKEN = "github_pat_TEST_" + "x".repeat(40);
const AUTH = "Basic " + Buffer.from("x-access-token:" + TOKEN).toString("base64");
const git = (...a) => execFileSync("git", a, { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const bare = join(tmp, "srv", "octo", "notes.git");
git("init", "-q", "--bare", bare);
git("-C", bare, "config", "http.receivepack", "true");

// (the stand-in proxy: the same routes as worker.mjs, CORS for the page, git http-backend behind; every request's
// Authorization recorded)
const seen = [];
let page = "";
const proxy = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const cors = { "access-control-allow-origin": page, vary: "Origin", "access-control-allow-headers": "authorization, content-type, accept, git-protocol, user-agent", "access-control-allow-methods": "GET, POST" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const m = /^\/github\.com(\/[^/]+\/[^/]+\.git\/(?:info\/refs|git-receive-pack))$/.exec(u.pathname);
  seen.push({ path: u.pathname + u.search, auth: req.headers.authorization ?? null });
  if (!m) { res.writeHead(400, cors); return res.end("no\n"); }
  if (req.headers.authorization !== AUTH) { res.writeHead(401, cors); return res.end("A token is required\n"); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const p = spawn("git", ["http-backend"], { env: { GIT_PROJECT_ROOT: join(tmp, "srv"), GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: m[1], QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length), REMOTE_USER: "t", REMOTE_ADDR: "127.0.0.1", PATH: process.env.PATH } });
  p.stdin.end(body);
  const out = []; for await (const c of p.stdout) out.push(c);
  const all = Buffer.concat(out), i = all.indexOf("\r\n\r\n");
  const headers = { ...cors }; let status = 200;
  for (const line of all.subarray(0, i).toString().split("\r\n")) { const k = line.slice(0, line.indexOf(":")), v = line.slice(line.indexOf(":") + 1).trim(); if (k.toLowerCase() === "status") status = parseInt(v); else headers[k.toLowerCase()] = v; }
  res.writeHead(status, headers);
  res.end(all.subarray(i + 4));
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const serve = spawn("python3", [join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((r) => serve.stdout.once("data", (d) => r(Number(String(d).trim().split(/\s+/).pop()))));
const base = `http://127.0.0.1:${port}/`;
page = `http://127.0.0.1:${port}`;
const profile = join(tmp, "profile");
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const cdp = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails.push(what); };
const W = "window.sagebrush?.workspace";
const P = "document.querySelector('.sbfprev')";
const openStorage = async () => {
  await ev(`(() => { document.querySelector(".sbfprev .ph .x")?.click(); return 1; })()`);
  await until(`!!document.querySelector("#wsfilesbtn") && !document.querySelector("#wsfilesbtn").hidden`, 60000);
  if (await ev(`document.querySelector('#wssidebar').hidden`)) await ev(`(document.querySelector("#wsfilesbtn").click(), 1)`);
  await until(`!!document.querySelector("#wssidebar .fmeter")`);
  await ev(`(document.querySelector("#wssidebar .fmeter").click(), 1)`);
  return until(`/Storage in this browser/.test(${P}?.textContent ?? "")`);
};
const btn = (re) => `[...${P}.querySelectorAll("button")].find((b) => ${re}.test(b.textContent))`;
const status = () => ev(`[...${P}.querySelectorAll("p.note")].map((p) => p.textContent).find((t) => /^(Pushed|Pushing|Not pushed yet|GitHub|Couldn't|The push|Nothing to push|Save a token|Too many|This push)/.test(t)) ?? ""`);
const tree = (ref = "sagebrush/proj") => git("-C", bare, "ls-tree", "-r", "--name-only", ref).trim().split("\n").filter(Boolean).sort();
const show = (path, ref = "sagebrush/proj") => git("-C", bare, "show", `${ref}:${path}`);

const NB = { mode: "python", cells: [{ id: "c1", code: "print(1)", outputs: [{ output_type: "stream", name: "stdout", text: "SECRET-OUTPUT\n" }], n: "3", ms: 12 }, { id: "c2", type: "markdown", code: "# Notes" }] };
try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await go(base);
  await until(`!!${W}`, 60000);
  await ev(`(async () => {
    const w = ${W};
    await w.create("/proj/a.txt", { content: "hello\\n" });
    await w.create("/proj/sub/b.bin", { content: new Uint8Array([0, 1, 2, 255]) });
    await w.create("/proj/gone.txt", { content: "to be removed\\n" });
    await w.create("/proj/nb.ipynb", { content: ${JSON.stringify(NB)} });
    await w.create("/proj/.sagebrush/history-x.json", { content: "{}" });
    await w.create("/outside.txt", { content: "not in the folder\\n" });
    return 1;
  })()`);
  // without the flag: not offered
  check(await openStorage(), "the Storage panel opens");
  check(!(await ev(`!!(${btn("/^Push to GitHub/")})`)), "without the flag, Push to GitHub isn't offered");
  await ev(`(localStorage.setItem("sagebrush.gitpush", ${JSON.stringify(proxyUrl)}), 1)`);
  await go(base);
  await until(`!!${W}`, 60000);
  check(await openStorage(), "the Storage panel opens again");
  check(await until(`!!(${btn("/^Push to GitHub/")})`), "with the flag, Push to GitHub… is offered: " + (await ev(`JSON.stringify([location.hostname, localStorage.getItem("sagebrush.gitpush"), [...${P}.querySelectorAll("button")].map((b) => b.textContent)])`)));
  await ev(`(${btn("/^Push to GitHub/")}.click(), 1)`);
  check(await until(`!!${P}.querySelector("input[type=url]")`), "…and opens its section");
  await ev(`(() => { const p = ${P}; const set = (el, v) => { el.value = v; el.dispatchEvent(new Event("change")); }; set(p.querySelector("input[type=url]"), "https://github.com/octo/notes"); set(p.querySelector("input[type=text]"), "/proj"); return 1; })()`);
  await until(`!!${P}.querySelector("input[type=password]")`);
  check(await ev(`${btn("/^Push now$/")}.disabled`), "Push now waits for a token");
  await ev(`(() => { ${P}.querySelector("input[type=password]").value = ${JSON.stringify(TOKEN)}; ${btn("/^Save token$/")}.click(); return 1; })()`);
  check(await until(`/Token saved in this browser/.test(${P}.textContent) && !${P}.querySelector("input[type=password]")`), "Save token: said, and its field gone");
  check(!(await ev(`document.documentElement.outerHTML.includes(${JSON.stringify(TOKEN)}) || JSON.stringify({ ...localStorage }).includes(${JSON.stringify(TOKEN)}) || JSON.stringify({ ...sessionStorage }).includes(${JSON.stringify(TOKEN)})`)), "the token is nowhere in the page, localStorage or sessionStorage");
  await ev(`(${btn("/^Push now$/")}.click(), 1)`);
  check(await until(`/^Pushed just now to sagebrush\\/proj \\([0-9a-f]{7}\\)$/.test(${P}.textContent.match(/Pushed[^)]*\\)/)?.[0] ?? "")`, 30000), "Push now: pushed to sagebrush/proj: " + (await status()));
  const t1 = tree();
  check(JSON.stringify(t1) === JSON.stringify(["a.txt", "gone.txt", "nb.ipynb", "sub/b.bin"]), "the branch holds the folder's files, relative to it, without .sagebrush or anything outside: " + JSON.stringify(t1));
  check(show("a.txt") === "hello\n" && Buffer.from(execFileSync("git", ["-C", bare, "show", "sagebrush/proj:sub/b.bin"])).equals(Buffer.from([0, 1, 2, 255])), "…their bytes exactly");
  const nb = JSON.parse(show("nb.ipynb"));
  check(nb.nbformat === 4 && nb.cells[0].outputs.length === 0 && nb.cells[0].execution_count === null && !show("nb.ipynb").includes("SECRET-OUTPUT") && nb.cells[0].metadata?.sagebrush?.ms === undefined && nb.cells[1].cell_type === "markdown", "the notebook is pushed as .ipynb without its outputs, count or run time");
  check(/Not pushed: 1 file/.test(await ev(`${P}.textContent`)) && /\.sagebrush\/history-x\.json: Sagebrush's own data/.test(await ev(`${P}.textContent`)), "what isn't pushed is listed, with why");
  check(git("-C", bare, "for-each-ref", "--format=%(refname)").trim() === "refs/heads/sagebrush/proj", "only sagebrush/proj exists on the server: nothing else (no main) was pushed");
  // a change and a removal
  await ev(`(async () => { const w = ${W}; await w.write("/proj/a.txt", "hello again\\n"); await w.remove("/proj/gone.txt"); return 1; })()`);
  const first = git("-C", bare, "rev-parse", "sagebrush/proj").trim();
  await ev(`(${btn("/^Push now$/")}.click(), 1)`);
  check(await until(`(() => { const t = ${P}.textContent.match(/Pushed[^)]*\\)/)?.[0] ?? ""; return !t.includes(${JSON.stringify(first.slice(0, 7))}) && /^Pushed just now/.test(t); })()`, 30000), "a second push: " + (await status()));
  check(JSON.stringify(tree()) === JSON.stringify(["a.txt", "nb.ipynb", "sub/b.bin"]) && show("a.txt") === "hello again\n", "…with the change, and without the removed file");
  check(git("-C", bare, "rev-parse", "sagebrush/proj~1").trim() === first, "…its parent the first push's commit (a fast-forward)");
  // nothing changed: a push that commits nothing
  const second = git("-C", bare, "rev-parse", "sagebrush/proj").trim();
  await ev(`(${btn("/^Push now$/")}.click(), 1)`);
  await until(`!${btn("/^Push now$/")}.disabled`, 30000);
  check(git("-C", bare, "rev-parse", "sagebrush/proj").trim() === second, "with nothing changed, no new commit");
  // the branch moved on the server: refused, nothing overwritten
  const other = join(tmp, "other");
  git("clone", "-q", "-b", "sagebrush/proj", bare, other);
  git("-C", other, "commit", "-q", "--allow-empty", "-m", "someone else");
  git("-C", other, "push", "-q", "origin", "sagebrush/proj");
  const moved = git("-C", bare, "rev-parse", "sagebrush/proj").trim();
  await ev(`(async () => { await ${W}.write("/proj/a.txt", "third\\n"); return 1; })()`);
  await ev(`(${btn("/^Push now$/")}.click(), 1)`);
  check(await until(`/GitHub's sagebrush\\/proj has commits this browser doesn't have\\. Nothing was overwritten\\./.test(${P}.textContent)`, 30000), "a branch moved on GitHub: refused in words: " + (await status()));
  check(git("-C", bare, "rev-parse", "sagebrush/proj").trim() === moved, "…and the server's branch is as it was (never forced)");
  // every request carried the token, and only to the proxy's two routes
  check(seen.length > 0 && seen.every((s) => s.auth === AUTH && /^\/github\.com\/octo\/notes\.git\/(info\/refs\?service=git-receive-pack|git-receive-pack)$/.test(s.path)), "every request went to the proxy's push routes, with the token: " + JSON.stringify([...new Set(seen.map((s) => s.path))]));
  // a wrong token: refused in fixed words; Forget token
  await ev(`(${btn("/^Forget token$/")}.click(), 1)`);
  check(await until(`!!${P}.querySelector("input[type=password]") && ${btn("/^Push now$/")}.disabled`), "Forget token: the token field is back, and Push now waits for one");
  await ev(`(() => { ${P}.querySelector("input[type=password]").value = "github_pat_WRONG_" + "y".repeat(40); ${btn("/^Save token$/")}.click(); return 1; })()`);
  await until(`/Token saved/.test(${P}.textContent)`);
  await ev(`(${btn("/^Push now$/")}.click(), 1)`);
  check(await until(`/GitHub refused the token \\(401\\)/.test(${P}.textContent)`, 30000), "a wrong token: \"GitHub refused the token (401)…\": " + (await status()));
  check(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));
} catch (e) {
  check(false, "threw: " + String(e?.stack ?? e).slice(0, 800));
} finally {
  chrome.kill(); serve.kill(); proxy.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`${checks - fails.length}/${checks} checks passed`);
process.exit(fails.length ? 1 : 0);
