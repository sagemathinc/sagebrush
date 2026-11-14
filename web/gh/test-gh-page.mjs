// ci: web-runner order=173 chrome
// A public GitHub repository's notebook and folder pages (/gh/..., web/gh/source.ts in the shared-collection page), end
// to end in Chromium against the built site (web/serve.py, its headers and CSP), with GitHub, raw.githubusercontent.com
// and jsDelivr answered by this test (CDP Fetch) from fixtures (web/gh/fixtures/math-repo: a notebook that reads the
// zeta-zero data beside it, a README and notes), as a repository o/math-notebooks with them in examples/notebooks.
// What it shows:
//   - the page's policy: its fetches to GitHub's three hosts (other origins than the page's) allowed, and refused to any
//     other site; the /s/ page's policy as it was;
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

// ---- the stand-in repository: o/math-notebooks at commit C, its examples/notebooks folder from the fixtures
const C = "0123456789abcdef0123456789abcdef01234567";
const fx = (f) => readFileSync(join(here, "fixtures", "math-repo", f));
const FILES = { "examples/notebooks/count-zeros.ipynb": fx("count-zeros.ipynb"), "examples/notebooks/README.md": fx("README.md"), "examples/notebooks/NOTES.txt": fx("NOTES.txt"), "examples/notebooks/zeta_zeros_1000.txt": fx("zeta_zeros_1000.txt"), "NOTES.txt": fx("NOTES.txt"),
  // (a picture beside it, which the README shows only when clicked)
  "examples/notebooks/plot.png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
  // (a data file in a folder below the notebook's, and enough files below that to pass the copy's 20-file cap)
  "examples/notebooks/data/x.csv": Buffer.from("n,p\n1,2\n2,3\n"),
  ...Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`examples/notebooks/data/pad/p${String(i + 1).padStart(2, "0")}.txt`, Buffer.from(`pad ${i + 1}\n`)])) };
const blobId = (b) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");
const TREE = { sha: "t".repeat(40), truncated: false, tree: [{ path: "examples", mode: "040000", type: "tree", sha: "a".repeat(40) }, { path: "examples/notebooks", mode: "040000", type: "tree", sha: "b".repeat(40) },
  ...Object.entries(FILES).map(([path, b]) => ({ path, mode: "100644", type: "blob", sha: blobId(b), size: b.length }))].sort((a, b) => (a.path < b.path ? -1 : 1)) };
const FLAT = { type: "gh", name: "o/math-notebooks", version: "main", files: Object.entries(FILES).map(([p, b]) => ({ name: "/" + p, hash: createHash("sha256").update(b).digest("base64"), size: b.length })) };
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
    if (u.pathname === "/repos/o/math-notebooks/commits/main") return { responseCode: 200, responseHeaders: [...CORS, { name: "Content-Type", value: "application/vnd.github.sha" }], body: Buffer.from(C) };
    if (u.pathname === `/repos/o/math-notebooks/git/trees/${C}` && u.searchParams.get("recursive") === "1") return json(200, TREE);
    return json(404, { message: "Not Found" });
  }
  if (u.host === "example.org") return { responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "image/png" }], body: FILES["examples/notebooks/plot.png"] };
  if (u.host === "data.jsdelivr.com") return mode === "limited" && u.pathname === "/v1/packages/gh/o/math-notebooks@main" ? json(200, FLAT) : json(404, { status: 404 });
  if (u.host === "raw.githubusercontent.com") {
    const m = /^\/o\/math-notebooks\/([^/]+)\/(.+)$/.exec(u.pathname);
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
  await send("Fetch.enable", { patterns: ["https://api.github.com/*", "https://raw.githubusercontent.com/*", "https://data.jsdelivr.com/*", "https://cdn.jsdelivr.net/*", "https://example.org/*"].map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  // (every refusal by the page's policy, from each page's start: GitHub's hosts are other origins than the page's)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__refused = []; document.addEventListener("securitypolicyviolation", (e) => window.__refused.push(e.effectiveDirective + " " + e.blockedURI));` });

  // ---- the policy: a /gh/ page's fetches go to GitHub's three hosts and no other site; the /s/ page's are as they were
  const GH_CONNECT = "connect-src 'self' data: blob: ws://127.0.0.1:* ws://localhost:* https://api.github.com https://raw.githubusercontent.com https://data.jsdelivr.com";
  const policyOf = async (path) => (await fetch(origin + path)).headers.get("content-security-policy") ?? "";
  const ghCsp = await policyOf("/gh/o/math-notebooks/tree/main/examples/notebooks"), sCsp = await policyOf("/s/");
  ok(/connect-src [^;]+/.exec(ghCsp)?.[0] === GH_CONNECT, "a /gh/ page's connect-src: GitHub's three hosts, by exact origin", ghCsp);
  ok(/connect-src [^;]+/.exec(sCsp)?.[0] === "connect-src 'self' data: blob: https: http: ws://127.0.0.1:* ws://localhost:*" && ghCsp.replace(/connect-src [^;]+/, "") === sCsp.replace(/connect-src [^;]+/, ""), "the /s/ page's policy unchanged, and the /gh/ page's otherwise the same", sCsp);

  // ---- a folder
  ok(await go("/gh/o/math-notebooks/tree/main/examples/notebooks"), "a folder's /gh/ page opens (the /s/ page)");
  ok(await until(`document.querySelectorAll("#files li").length >= 5 && !document.querySelector("#readme").hidden`), "its list and its README");
  ok(await text("#title") === "o/math-notebooks / examples/notebooks", "titled by the repository and the folder", await text("#title"));
  const meta = await ev(`document.querySelector("#meta").innerText`);
  ok(/^From github\.com\/o\/math-notebooks\nmain at 0123456\nCopy badge$/.test(meta), "the banner: where it's from, the ref and its commit, and Copy badge", meta);
  ok(await ev(`document.querySelector("#meta a").href`) === `https://github.com/o/math-notebooks/tree/${C}/examples/notebooks`, "the banner links to the folder on GitHub, at the commit");
  const items = await ev(`[...document.querySelectorAll("#files li")].map((l) => l.firstElementChild.textContent)`);
  ok(JSON.stringify(items) === JSON.stringify(["../", "data/", "NOTES.txt", "README.md", "count-zeros.ipynb", "plot.png", "zeta_zeros_1000.txt"]), "the folder's files, a link up, no download links (GitHub's own are a click away)", items);
  const links = await ev(`[...document.querySelectorAll("#readme a")].map((a) => a.getAttribute("href"))`);
  ok(links.includes("/gh/o/math-notebooks/blob/main/examples/notebooks/01-primes-as-atoms.ipynb") && links.includes("/gh/o/math-notebooks/blob/main/examples/notebooks/NOTES.txt") && links.includes("https://sagebrush.space"), "the README's relative links go to /gh/ pages at the same ref; its absolute ones stay", links.slice(0, 3));
  // (the README's pictures, a relative one and another site's: none fetched on opening the folder, each a button that
  // loads it when clicked, as an imported document's pictures are)
  await sleep(1500);
  const pics = await ev(`[...document.querySelectorAll("#readme button.remote-picture")].map((b) => [b.dataset.loadSrc, b.textContent])`);
  ok(pics.length === 2 && pics[0][0] === `https://raw.githubusercontent.com/o/math-notebooks/${C}/examples/notebooks/plot.png` && pics[1][0] === "https://example.org/remote.png" && !(await ev(`!!document.querySelector("#readme img")`)), "the README's pictures are buttons, the relative one by its raw URL at the commit", pics);
  ok(!asked.some((a) => a.startsWith("example.org") || a.endsWith("/plot.png")), "opening the folder fetched no picture", asked);
  await ev(`document.querySelector("#readme button.remote-picture").click(), 1`);
  ok(await until(`!!document.querySelector("#readme img")`) && (await sleep(500), asked.includes(`raw.githubusercontent.com/o/math-notebooks/${C}/examples/notebooks/plot.png`)) && !asked.some((a) => a.startsWith("example.org")), "a click loads that picture, and only it", asked);
  ok(JSON.stringify(await ev("window.__refused")) === "[]", "the folder, its README and a picture: nothing the policy refused (GitHub's hosts allowed)", await ev("window.__refused"));
  const refused = await ev(`new Promise((r) => { document.addEventListener("securitypolicyviolation", (e) => r(e.effectiveDirective + " " + e.blockedURI), { once: true }); fetch("https://cdn.jsdelivr.net/gh/o/math-notebooks@main/NOTES.txt").catch(() => {}); setTimeout(() => r(null), 5000); })`);
  ok(refused === "connect-src https://cdn.jsdelivr.net/gh/o/math-notebooks@main/NOTES.txt" && !asked.some((a) => a.startsWith("cdn.jsdelivr.net")), "a fetch to another site is refused by the policy, never sent", { refused, asked });
  ok(asked.filter((a) => a.startsWith("api.github.com")).join() === `api.github.com/repos/o/math-notebooks/commits/main,api.github.com/repos/o/math-notebooks/git/trees/${C}` && asked.includes("raw.githubusercontent.com/o/math-notebooks/" + C + "/examples/notebooks/README.md"), "two calls on GitHub's API; the README from raw, at the commit", asked);

  // ---- a notebook: nothing runs until Run; Run all reads the data file beside it
  ok(await go("/gh/o/math-notebooks/blob/main/examples/notebooks/count-zeros.ipynb"), "a notebook's /gh/ page");
  ok(await until(`!document.querySelector("#nb").hidden`, 60000), "the notebook opens");
  ok(/^Nothing has run yet/.test(await text("#status")) && (await ev(`window.shared.nb.snapshot().cells.filter((c) => !c.type).every((c) => c.n == null)`)), "nothing has run", await text("#status"));
  ok(await ev(`document.querySelector("#files").hidden && document.querySelector("#filestoggle").textContent === "examples/notebooks · 5 files ▸"`), "its folder's list folded into one line", await text("#filestoggle"));
  await ev(`document.querySelector("#filestoggle").click(), 1`);
  ok(await ev(`!document.querySelector("#files").hidden && document.querySelector("#filestoggle").textContent.endsWith("▾") && document.querySelector("#filestoggle").getAttribute("aria-expanded") === "true"`), "…which opens");
  const outText = `(window.shared.nb.snapshot().cells.filter((c) => !c.type)[0].outputs ?? []).map((o) => o.text ?? o.data?.["text/plain"] ?? o.evalue ?? "").join("")`;
  await ev(`document.querySelector("#runall").click(), 1`);
  ok(await until(`/1000 numbers of the Riemann spectrum, up to 1419\\.422480946/.test(${outText})`, 180000), "Run all reads zeta_zeros_1000.txt from the notebook's own folder, through the mount", await ev(outText).catch(() => null));
  ok(asked.includes(`raw.githubusercontent.com/o/math-notebooks/${C}/examples/notebooks/zeta_zeros_1000.txt`), "…from raw, at the commit");
  ok(JSON.stringify(await ev("window.__refused")) === "[]", "…and nothing the policy refused", await ev("window.__refused"));

  // ---- the first edit makes the reader's copy
  await ev(`(() => { const ta = document.querySelector('#nb .cell:not(.md) textarea') ?? [...document.querySelectorAll('#nb textarea')].pop(); ta.value += "\\nprint('mine')"; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  ok(await until(`/kept in this browser at \\/GitHub\\/o\\/math-notebooks\\/examples\\/notebooks\\/count-zeros\\.ipynb/.test(document.querySelector("#copyline").textContent)`, 60000), "the first edit: the copy, at /GitHub/o/math-notebooks/examples/notebooks/count-zeros.ipynb", await text("#copyline"));
  ok(/Back to GitHub's version/.test(await text("#copyline")), "…with \"Back to GitHub's version\"");
  const copied = await ev(`(async () => { const ws = await (await import("/sagebrush-share-copy.js")).openWorkspace(); return (await ws.list("/GitHub/o/math-notebooks/examples/notebooks")).map((e) => e.path).sort(); })()`);
  ok(JSON.stringify(copied) === JSON.stringify(["/GitHub/o/math-notebooks/examples/notebooks/NOTES.txt", "/GitHub/o/math-notebooks/examples/notebooks/README.md", "/GitHub/o/math-notebooks/examples/notebooks/count-zeros.ipynb", "/GitHub/o/math-notebooks/examples/notebooks/data", "/GitHub/o/math-notebooks/examples/notebooks/plot.png", "/GitHub/o/math-notebooks/examples/notebooks/zeta_zeros_1000.txt"]), "…with the files of its folder beside it (not the repository's other files)", copied);
  const below = await ev(`(async () => { const ws = await (await import("/sagebrush-share-copy.js")).openWorkspace(); const d = (await ws.list("/GitHub/o/math-notebooks/examples/notebooks/data")).map((e) => e.path); const p = (await ws.list("/GitHub/o/math-notebooks/examples/notebooks/data/pad")).map((e) => e.path); return { d, p }; })()`);
  ok(below.d.includes("/GitHub/o/math-notebooks/examples/notebooks/data/x.csv") && below.p.length === 15, "…and its subfolders' files, the folder's own first, up to the copy's 20 files: data/x.csv and 15 of data/pad's 19", below);
  ok(/^4 files of its folder stayed on GitHub \(over the copy's limit of 20 files or 10 MB\): data\/pad\/p16\.txt, data\/pad\/p17\.txt, data\/pad\/p18\.txt, data\/pad\/p19\.txt\.$/.test(await text("#status")), "the 4 over the cap are named, each with its path below the notebook's folder", await text("#status"));

  // ---- bytes that aren't the listed ones can't be read
  tamper = true;
  ok(await go("/gh/o/math-notebooks/blob/main/examples/notebooks/count-zeros.ipynb?original"), "(again, the file now served with other bytes)");
  await until(`!document.querySelector("#nb").hidden`, 60000);
  // (the reader's copy opens now: back to GitHub's version, whose bytes come from raw)
  await ev(`[...document.querySelectorAll("#copyline button")].find((b) => /GitHub's version/.test(b.textContent))?.click(), 1`);
  await until(`/Nothing has run yet/.test(document.querySelector("#status").textContent)`, 30000);
  await ev(`document.querySelector("#runall").click(), 1`);
  ok(await until(`/EIO|Errno 5/.test(${outText}) && /git blob id/.test(${outText})`, 180000), "a file whose bytes aren't its listing's: EIO, \"wrong git blob id\"", await ev(outText).catch(() => null));
  tamper = false;

  // ---- not found, the limit, and an address that isn't one
  mode = "notfound";
  await go("/gh/o/math-notebooks/blob/main/examples/notebooks/count-zeros.ipynb");
  ok(await until(`/^Not found on GitHub: o\\/math-notebooks at main\\. If the repository is private, Sagebrush can't open it yet\\.$/.test(document.querySelector("#status").textContent)`) && await text("#title") === "This can't be opened from GitHub", "not found, or private: one line, and the title says so", await text("#status"));
  mode = "limited";
  await go("/gh/o/math-notebooks/tree/main/examples/notebooks");
  ok(await until(`/\\(via jsDelivr, may be up to 12 hours old\\)/.test(document.querySelector("#meta").innerText) && document.querySelectorAll("#files li").length >= 5`), "GitHub's limit used up: jsDelivr's listing, and the banner says it may be behind", await ev(`document.querySelector("#meta").innerText`));
  ok(asked.some((a) => a === "data.jsdelivr.com/v1/packages/gh/o/math-notebooks@main") && !asked.some((a) => a.startsWith("api.github.com/repos/o/math-notebooks/git/trees")), "…one call refused, then jsDelivr", asked);
  mode = "limitedAll";
  await go("/gh/o/math-notebooks/tree/main/examples/notebooks");
  ok(await until(`/^GitHub's limit for your network is used up until .+\\. Try again then\\.$/.test(document.querySelector("#status").textContent)`), "the limit, and jsDelivr can't list it either: when to try again", await text("#status"));
  mode = "ok";
  await go("/gh/-o/math-notebooks/blob/main/x.ipynb");
  ok(await until(`document.querySelector("#status").textContent === "That isn't a GitHub file or folder address."`) && asked.length === 0, "an address that isn't one: said, and nothing asked of GitHub", await text("#status"));
} catch (e) {
  ok(false, "the test ran: " + (e?.stack ?? e));
} finally {
  try { chrome.kill(); } catch {}
  server.kill();
}
console.log(failures ? `${failures} of ${checks} failed` : `all ${checks} passed`);
process.exit(failures ? 1 : 0);
