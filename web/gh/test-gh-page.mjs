// ci: web-runner order=173 chrome
// A public GitHub repository's notebook and folder pages (/gh/..., web/gh/source.ts in the shared-collection page), end
// to end in Chromium against the built site (web/serve.py, its headers and CSP), with GitHub, raw.githubusercontent.com
// and jsDelivr answered by this test (CDP Fetch) from fixtures shaped like the rh notebooks' folder (web/gh/fixtures/rh:
// zeta_zeros_1000.txt as it is in that repository, a notebook holding its notebook 09's first cell, as Python, and a
// README and notes written for the test). What it shows:
//   - a folder: its title and banner (repository, ref, commit), its files, its README rendered with its links to /gh/
//     pages; two calls on GitHub's API (the commit, then its tree), none for the README (raw, checked);
//   - a notebook: opened with nothing run, its folder's list folded into one line; Run all reads zeta_zeros_1000.txt
//     through the mount, from the notebook's own folder (1000 numbers, up to 1419.422480946);
//   - the first edit makes the reader's copy at /GitHub/<owner>/<repo>/<path>, with the files of its folder beside it;
//   - a file whose bytes aren't the ones listed (its git blob id) can't be read: EIO, and the cell says why;
//   - not found (or private), GitHub's limit (with jsDelivr's listing, and the banner's line), the limit with jsDelivr
//     failing too, and an address that isn't one: each said in one line.
//   bun web/build.ts && CHROME=chromium node web/gh/test-gh-page.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
let failures = 0, checks = 0;
const ok = (c, msg, detail) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 500))); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the stand-in repository: o/rh at commit C, its notebooks folder from the fixtures
const C = "6f31aafa5bfb3f52ba1ae4b39c4ba409bdc01a34";
const fx = (f) => readFileSync(join(here, "fixtures", "rh", f));
const FILES = { "rh/notebooks/09-first-cell.ipynb": fx("09-first-cell.ipynb"), "rh/notebooks/README.md": fx("README.md"), "rh/notebooks/NOTES.txt": fx("NOTES.txt"), "rh/notebooks/zeta_zeros_1000.txt": fx("zeta_zeros_1000.txt"), "NOTES.txt": fx("NOTES.txt") };
const blobId = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");
const TREE = { sha: "t".repeat(40), truncated: false, tree: [{ path: "rh", mode: "040000", type: "tree", sha: "a".repeat(40) }, { path: "rh/notebooks", mode: "040000", type: "tree", sha: "b".repeat(40) },
  ...Object.entries(FILES).map(([path, b]) => ({ path, mode: "100644", type: "blob", sha: blobId(b), size: b.length }))].sort((a, b) => (a.path < b.path ? -1 : 1)) };
const FLAT = { type: "gh", name: "o/rh", version: "main", files: Object.entries(FILES).map(([p, b]) => ({ name: "/" + p, hash: createHash("sha256").update(b).digest("base64"), size: b.length })) };
// (what this test's GitHub does now: "ok", "notfound", "limited" (jsDelivr lists), "limitedAll" (jsDelivr fails too);
// `tamper`: raw serves other bytes for zeta_zeros_1000.txt)
let mode = "ok", tamper = false;
const asked = [];
const CORS = [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Expose-Headers", value: "X-RateLimit-Remaining, X-RateLimit-Reset" }];
function answer(url) {
  const u = new URL(url);
  asked.push(u.host + u.pathname);
  const json = (code, body, extra = []) => ({ responseCode: code, responseHeaders: [...CORS, { name: "Content-Type", value: "application/json" }, ...extra], body: Buffer.from(JSON.stringify(body)) });
  const limit = [{ name: "X-RateLimit-Remaining", value: "0" }, { name: "X-RateLimit-Reset", value: String(Math.floor(Date.now() / 1000) + 1800) }];
  if (u.host === "api.github.com") {
    if (mode === "notfound") return json(404, { message: "Not Found" });
    if (mode.startsWith("limited")) return json(403, { message: "API rate limit exceeded" }, limit);
    if (u.pathname === "/repos/o/rh/commits/main") return { responseCode: 200, responseHeaders: [...CORS, { name: "Content-Type", value: "application/vnd.github.sha" }], body: Buffer.from(C) };
    if (u.pathname === `/repos/o/rh/git/trees/${C}` && u.searchParams.get("recursive") === "1") return json(200, TREE);
    return json(404, { message: "Not Found" });
  }
  if (u.host === "data.jsdelivr.com") return mode === "limited" && u.pathname === "/v1/packages/gh/o/rh@main" ? json(200, FLAT) : json(404, { status: 404 });
  if (u.host === "raw.githubusercontent.com") {
    const m = /^\/o\/rh\/([^/]+)\/(.+)$/.exec(u.pathname);
    const p = m && decodeURIComponent(m[2]);
    if (!m || !(m[1] === C || (mode === "limited" && m[1] === "main")) || !FILES[p]) return { responseCode: 404, responseHeaders: CORS, body: Buffer.from("404: Not Found") };
    const b = tamper && p.endsWith("zeta_zeros_1000.txt") ? Buffer.from(FILES[p].toString().replace("14.1347251417347", "14.1347251417348")) : FILES[p];
    return { responseCode: 200, responseHeaders: [...CORS, { name: "Content-Type", value: "text/plain; charset=utf-8" }], body: b };
  }
  return null;
}

// ---- the built site, as web/serve.py serves it (the site's headers: COOP/COEP and the CSP); /gh/ is the /s/ page
const server = spawn("python3", ["-u", join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const origin = `http://127.0.0.1:${sport}`;
let cdp = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-gh-page-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, "--window-size=1300,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  if (!cdp) cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map();
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Fetch.requestPaused") {
      const a = answer(m.params.request.url);
      if (!a) return void send("Fetch.continueRequest", { requestId: m.params.requestId });
      void send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: a.responseCode, responseHeaders: a.responseHeaders, body: a.body.toString("base64") });
    }
  };
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 400)); return r.result.result.value; };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(150); } return false; };
  const go = async (path) => { asked.length = 0; await ev("window.__old = 1").catch(() => {}); await send("Page.navigate", { url: origin + path }); await sleep(300); return until("!window.__old && document.readyState === 'complete'", 30000); };
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`);
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Fetch.enable", { patterns: ["https://api.github.com/*", "https://raw.githubusercontent.com/*", "https://data.jsdelivr.com/*", "https://cdn.jsdelivr.net/*"].map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });

  // ---- a folder
  ok(await go("/gh/o/rh/tree/main/rh/notebooks"), "a folder's /gh/ page opens (the /s/ page)");
  ok(await until(`document.querySelectorAll("#files li").length >= 5 && !document.querySelector("#readme").hidden`), "its list and its README");
  ok(await text("#title") === "o/rh / rh/notebooks", "titled by the repository and the folder", await text("#title"));
  const meta = await ev(`document.querySelector("#meta").innerText`);
  ok(/^From github\.com\/o\/rh\nmain at 6f31aaf\nCopy badge$/.test(meta), "the banner: where it's from, the ref and its commit, and Copy badge", meta);
  ok(await ev(`document.querySelector("#meta a").href`) === `https://github.com/o/rh/tree/${C}/rh/notebooks`, "the banner links to the folder on GitHub, at the commit");
  const items = await ev(`[...document.querySelectorAll("#files li")].map((l) => l.firstElementChild.textContent)`);
  ok(JSON.stringify(items) === JSON.stringify(["../", "09-first-cell.ipynb", "NOTES.txt", "README.md", "zeta_zeros_1000.txt"]), "the folder's files, a link up, no download links (GitHub's own are a click away)", items);
  const links = await ev(`[...document.querySelectorAll("#readme a")].map((a) => a.getAttribute("href"))`);
  ok(links.includes("/gh/o/rh/blob/main/rh/notebooks/01-primes-as-atoms.ipynb") && links.includes("/gh/o/rh/blob/main/rh/notebooks/NOTES.txt") && links.includes("https://sagebrush.space"), "the README's relative links go to /gh/ pages at the same ref; its absolute ones stay", links.slice(0, 3));
  ok(asked.filter((a) => a.startsWith("api.github.com")).join() === `api.github.com/repos/o/rh/commits/main,api.github.com/repos/o/rh/git/trees/${C}` && asked.includes("raw.githubusercontent.com/o/rh/" + C + "/rh/notebooks/README.md"), "two calls on GitHub's API; the README from raw, at the commit", asked);

  // ---- a notebook: nothing runs until Run; Run all reads the data file beside it
  ok(await go("/gh/o/rh/blob/main/rh/notebooks/09-first-cell.ipynb"), "a notebook's /gh/ page");
  ok(await until(`!document.querySelector("#nb").hidden`, 60000), "the notebook opens");
  ok(/^Nothing has run yet/.test(await text("#status")) && (await ev(`window.shared.nb.snapshot().cells.filter((c) => !c.type).every((c) => c.n == null)`)), "nothing has run", await text("#status"));
  ok(await ev(`document.querySelector("#files").hidden && document.querySelector("#filestoggle").textContent === "rh/notebooks · 4 files ▸"`), "its folder's list folded into one line", await text("#filestoggle"));
  await ev(`document.querySelector("#filestoggle").click(), 1`);
  ok(await ev(`!document.querySelector("#files").hidden && document.querySelector("#filestoggle").textContent.endsWith("▾") && document.querySelector("#filestoggle").getAttribute("aria-expanded") === "true"`), "…which opens");
  const outText = `(window.shared.nb.snapshot().cells.filter((c) => !c.type)[0].outputs ?? []).map((o) => o.text ?? o.data?.["text/plain"] ?? o.evalue ?? "").join("")`;
  await ev(`document.querySelector("#runall").click(), 1`);
  ok(await until(`/1000 numbers of the Riemann spectrum, up to 1419\\.422480946/.test(${outText})`, 180000), "Run all reads zeta_zeros_1000.txt from the notebook's own folder, through the mount", await ev(outText).catch(() => null));
  ok(asked.includes(`raw.githubusercontent.com/o/rh/${C}/rh/notebooks/zeta_zeros_1000.txt`), "…from raw, at the commit");

  // ---- the first edit makes the reader's copy
  await ev(`(() => { const ta = document.querySelector('#nb .cell:not(.md) textarea') ?? [...document.querySelectorAll('#nb textarea')].pop(); ta.value += "\\nprint('mine')"; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  ok(await until(`/kept in this browser at \\/GitHub\\/o\\/rh\\/rh\\/notebooks\\/09-first-cell\\.ipynb/.test(document.querySelector("#copyline").textContent)`, 60000), "the first edit: the copy, at /GitHub/o/rh/rh/notebooks/09-first-cell.ipynb", await text("#copyline"));
  ok(/Back to GitHub's version/.test(await text("#copyline")), "…with \"Back to GitHub's version\"");
  const copied = await ev(`(async () => { const ws = await (await import("/sagebrush-share-copy.js")).openWorkspace(); return (await ws.list("/GitHub/o/rh/rh/notebooks")).map((e) => e.path).sort(); })()`);
  ok(JSON.stringify(copied) === JSON.stringify(["/GitHub/o/rh/rh/notebooks/09-first-cell.ipynb", "/GitHub/o/rh/rh/notebooks/NOTES.txt", "/GitHub/o/rh/rh/notebooks/README.md", "/GitHub/o/rh/rh/notebooks/zeta_zeros_1000.txt"]), "…with the files of its folder beside it (not the repository's other files)", copied);

  // ---- bytes that aren't the listed ones can't be read
  tamper = true;
  ok(await go("/gh/o/rh/blob/main/rh/notebooks/09-first-cell.ipynb?original"), "(again, the file now served with other bytes)");
  await until(`!document.querySelector("#nb").hidden`, 60000);
  // (the reader's copy opens now: back to GitHub's version, whose bytes come from raw)
  await ev(`[...document.querySelectorAll("#copyline button")].find((b) => /GitHub's version/.test(b.textContent))?.click(), 1`);
  await until(`/Nothing has run yet/.test(document.querySelector("#status").textContent)`, 30000);
  await ev(`document.querySelector("#runall").click(), 1`);
  ok(await until(`/EIO|Errno 5/.test(${outText}) && /git blob id/.test(${outText})`, 180000), "a file whose bytes aren't its listing's: EIO, \"wrong git blob id\"", await ev(outText).catch(() => null));
  tamper = false;

  // ---- not found, the limit, and an address that isn't one
  mode = "notfound";
  await go("/gh/o/rh/blob/main/rh/notebooks/09-first-cell.ipynb");
  ok(await until(`/^Not found on GitHub: o\\/rh at main\\. If the repository is private, Sagebrush can't open it yet\\.$/.test(document.querySelector("#status").textContent)`) && await text("#title") === "This can't be opened from GitHub", "not found, or private: one line, and the title says so", await text("#status"));
  mode = "limited";
  await go("/gh/o/rh/tree/main/rh/notebooks");
  ok(await until(`/\\(via jsDelivr, may be up to 12 hours old\\)/.test(document.querySelector("#meta").innerText) && document.querySelectorAll("#files li").length >= 5`), "GitHub's limit used up: jsDelivr's listing, and the banner says it may be behind", await ev(`document.querySelector("#meta").innerText`));
  ok(asked.some((a) => a === "data.jsdelivr.com/v1/packages/gh/o/rh@main") && !asked.some((a) => a.startsWith("api.github.com/repos/o/rh/git/trees")), "…one call refused, then jsDelivr", asked);
  mode = "limitedAll";
  await go("/gh/o/rh/tree/main/rh/notebooks");
  ok(await until(`/^GitHub's limit for your network is used up until .+\\. Try again then\\.$/.test(document.querySelector("#status").textContent)`), "the limit, and jsDelivr can't list it either: when to try again", await text("#status"));
  mode = "ok";
  await go("/gh/-o/rh/blob/main/x.ipynb");
  ok(await until(`document.querySelector("#status").textContent === "That isn't a GitHub file or folder address."`) && asked.length === 0, "an address that isn't one: said, and nothing asked of GitHub", await text("#status"));
} catch (e) {
  ok(false, "the test ran: " + (e?.stack ?? e));
} finally {
  try { chrome.kill(); } catch {}
  server.kill();
}
console.log(failures ? `${failures} of ${checks} failed` : `all ${checks} passed`);
process.exit(failures ? 1 : 0);
