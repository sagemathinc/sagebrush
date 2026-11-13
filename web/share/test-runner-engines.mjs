// ci: inline (ci.yml's webkit job: its Firefox step, and its WebKit step)
// Code runs in the sandboxed runner in Firefox and WebKit as in Chromium (web/notebook/runner-browser.js, web/csp.ts,
// web/runner/index.html): against the share API in Miniflare (web/share/serve-dev.mjs) and web/dist, in a fresh profile,
//   1. a shared notebook's page: Run all runs it, in the runner frame (sandbox="allow-scripts", no plain worker), whose
//      origin is opaque, with no storage, no cookies and no reach into the page; the runner's page says CORP;
//   2. the notebook page: a new notebook's cell runs, in the runner frame, never refused for want of one ("This
//      notebook can't run here", what Firefox and Safari said on every cell before: no runner was tried there);
//   3. WebKit only: the runner's worker is a data: one (WebKit refuses a blob: worker in the frame, under its COEP), and
//      from inside it there is no fetch, WebSocket, IndexedDB or script to load, where the page's own worker finds
//      them; a browser that doesn't say it is WebKit tries the blob: worker first, and runs in the data: one.
//   BROWSER=firefox|webkit|chromium PLAYWRIGHT=<playwright's dir> node web/share/test-runner-engines.mjs   (CHROME=... for chromium)
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { startDev } from "./serve-dev.mjs";

const ENGINE = process.env.BROWSER ?? "firefox";
const require = createRequire(join(process.env.PLAYWRIGHT ?? process.cwd(), "package.json"));
let pw;
try { pw = require("playwright-core"); } catch { pw = require("playwright"); }
const A = "77777777-dddd-4777-8777-777777777777";
const dev = await startDev({ sitePort: 0, filesPort: 0, limits: { [A]: { tier: "dev", storage_bytes: 1e8, max_file_bytes: 1e7, private_links: false } } });
const J = JSON.stringify;
const sha = (b) => createHash("sha256").update(b).digest("hex");
let failures = 0, count = 0;
const ok = (c, msg) => { count++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
let browser;
try {
  // (a share, published through the API as the page publishes it)
  const signed = await fetch(dev.site + "/auth/dev", { method: "POST", headers: { origin: dev.site, "content-type": "application/json" }, body: J({ token: "dev-token", account_id: A }) });
  const cookie = signed.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const api = (p, m, b, t = "application/json") => fetch(dev.site + p, { method: m, headers: { origin: dev.site, cookie, "content-type": t }, body: b });
  const nb = Buffer.from(J({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: "print(6 * 7)" }] }));
  await api("/api/share/check", "POST", J({ blobs: [{ sha256: sha(nb), size: nb.length }] }));
  await api(`/api/share/blob/${sha(nb)}`, "PUT", nb, "application/octet-stream");
  const id = (await (await api("/api/share/first-upload", "POST", J({ title: "Engines", license: "MIT", files: [{ path: "n.ipynb", sha256: sha(nb), size: nb.length }], attempt: randomBytes(16).toString("hex") }))).json()).collection;
  ok(/^[a-z2-7]{12}$/.test(id ?? ""), `(a share published: ${id})`);
  const corp = (await fetch(dev.site + "/runner/")).headers.get("cross-origin-resource-policy");
  ok(corp === "cross-origin", `the runner's page says Cross-Origin-Resource-Policy: cross-origin (${corp}): an isolated page can embed it in Firefox`);

  browser = await pw[ENGINE].launch(ENGINE === "chromium" && process.env.CHROME ? { executablePath: process.env.CHROME, args: ["--no-sandbox"] } : {});
  const page = await (await browser.newContext()).newPage();
  const blocked = [];
  page.on("console", (m) => { if (/blocked|Cross-Origin-Resource-Policy/i.test(m.text())) blocked.push(m.text().slice(0, 200)); });
  ok(true, `(${ENGINE} ${browser.version()})`);

  // ---- 1. the share page
  await page.goto(`${dev.site}/s/${id}`);
  await page.waitForFunction(() => !!window.shared && !!document.querySelector("#nb .cell"), null, { timeout: 60000 });
  const env = await page.evaluate(() => ({ isolated: globalThis.crossOriginIsolated, frames: document.querySelectorAll("iframe[sandbox]").length }));
  ok(env.isolated === true, "the page is cross-origin isolated");
  await page.click("#runall");
  await page.waitForFunction(() => (document.querySelector("#nb .cell .out")?.textContent ?? "").trim() === "42" && !document.querySelector("#nb .cell.running, #nb .cell.queued"), null, { timeout: 60000 }).catch(() => {});
  const ran = await page.evaluate(() => ({ out: (document.querySelector("#nb .cell .out")?.textContent ?? "").trim(), sandbox: [...document.querySelectorAll("iframe[sandbox]")].map((f) => f.getAttribute("sandbox")), ours: window.shared.kernel.worker?.frame === document.querySelector("iframe[sandbox]"), plain: !!window.shared.kernel.worker?.inner }));
  ok(ran.out === "42" && J(ran.sandbox) === J(["allow-scripts"]) && ran.ours && !ran.plain, "Run all runs the shared notebook, in the runner frame, never a plain worker: " + J(ran));
  const runner = page.frames().find((f) => /\/runner\/$/.test(f.url()));
  const inside = runner ? await runner.evaluate(() => { const t = (f) => { try { return f(); } catch { return "refused"; } }; return { origin: self.origin, localStorage: t(() => typeof localStorage.length), indexedDB: t(() => (indexedDB.open("sb-probe"), "opened")), cookie: t(() => typeof document.cookie), page: t(() => typeof parent.document) }; }) : null;
  ok(!!inside && inside.origin === "null" && inside.localStorage === "refused" && inside.indexedDB === "refused" && inside.cookie === "refused" && inside.page === "refused", "inside the runner frame: an opaque origin, no storage, no cookies, no page: " + J(inside));

  // ---- 2. the notebook page
  await page.goto(`${dev.site}/`);
  await page.waitForFunction(() => !!window.sagebrush?.notebook && document.querySelectorAll(".cell").length > 0 && !document.body.classList.contains("opening"), null, { timeout: 90000 });
  await page.evaluate(() => document.querySelector("#filemenu [data-f=new]").click());
  await page.waitForFunction(() => document.querySelectorAll(".cell").length === 1 && !document.querySelector(".cell textarea").value, null, { timeout: 30000 });
  const perms = await page.evaluate(() => window.sagebrush.permissions?.()?.files);
  const out = await page.evaluate(async () => { const n = window.sagebrush.notebook; const f = n.cells()[0].id; const x = await Promise.race([n.applyEdits({ set: [{ id: f, code: "print(6 * 7)" }] }), new Promise((r) => setTimeout(() => r(null), 90000))]); return x ? String(x.outputs?.[f] ?? "").trim() : "(no answer in 90 s)"; });
  // (the kernel's worker is the runner: its frame is one of the page's sandboxed frames, and it gave up for no other)
  const where = await page.evaluate(() => { const w = window.sagebrush.kernel?.worker; const fs = [...document.querySelectorAll("iframe[sandbox]")]; return { sandbox: fs.map((f) => f.getAttribute("sandbox")), runner: !!w?.frame && fs.includes(w.frame), plain: !!w?.inner }; });
  ok(perms === false && out === "42", `a new notebook, its file changes off (${perms}), runs its cell: ${J(out.slice(0, 200))}`);
  ok(!/can't run here/.test(out) && where.runner && !where.plain && where.sandbox.every((x) => x === "allow-scripts"), "...in the runner frame, never refused: " + J(where));
  ok(blocked.length === 0, "nothing was blocked loading the runner: " + J(blocked));

  // ---- 3. WebKit: the runner's worker is a data: one (a blob: worker is refused there under the frame's COEP), and
  // from inside it, as an escape would be, nothing but its own messages: no network, no WebSocket, no storage.  The
  // same probe in the page's own worker (the analyzer, a plain worker of the site's origin) finds them, so the probe
  // can tell.
  if (ENGINE === "webkit") {
    const PROBE = async (site) => {
      const t = async (f) => { try { return await f(); } catch { return "refused"; } };
      return {
        origin: self.origin,
        fetchSite: await t(async () => (await fetch(site + "/")).status),
        fetchFile: await t(async () => (await fetch(site + "/sagebrush-worker.js")).status),
        fetchElsewhere: await t(async () => (await fetch("https://example.com/")).status),
        webSocket: await t(() => new Promise((res) => { const s = new WebSocket(site.replace(/^http/, "ws") + "/"); s.onopen = () => res("open"); s.onerror = () => res("refused"); s.onclose = () => res("refused"); })),
        indexedDB: await t(() => new Promise((res) => { const q = indexedDB.open("sb-probe"); q.onsuccess = () => res("opened"); q.onerror = () => res("refused"); })),
        importScripts: await t(() => (importScripts(site + "/sagebrush-analyze.js"), "loaded")),
      };
    };
    const probe = async (w) => w.evaluate(`(${PROBE})(${J(dev.site)})`);
    // (the runners' workers: every data: worker (the page's runner frames: the kernel's, and the notebook's other one);
    // the page's: the analyzer, by its own URL.  The control can't open a WebSocket either (the dev server takes none)
    // or reach elsewhere (no network here): its fetches, IndexedDB and script are what tell the probe apart)
    const runnerWorkers = page.workers().filter((w) => w.url().startsWith("data:"));
    const own = page.workers().find((w) => w.url() === dev.site + "/sagebrush-analyze.js");
    ok(runnerWorkers.length >= 1, `the runners' workers are data: ones: ${J(page.workers().map((w) => w.url().slice(0, 40)))}`);
    const refused = (x) => x === "refused";
    for (const [i, w] of runnerWorkers.entries()) {
      const r = await probe(w);
      ok(r.origin === "null" && refused(r.fetchSite) && refused(r.fetchFile) && refused(r.fetchElsewhere) && refused(r.webSocket) && refused(r.indexedDB) && refused(r.importScripts), `inside runner worker ${i + 1}: an opaque origin, no fetch (the site, its files, elsewhere), no WebSocket, no IndexedDB, no script loaded: ` + J(r));
    }
    const c = own ? await probe(own) : null;
    ok(!!c && c.origin === dev.site && c.fetchSite === 200 && c.fetchFile === 200 && c.indexedDB === "opened" && c.importScripts === "loaded", "control, the page's own worker: the same probe finds the site, its files, IndexedDB and a script: " + J(c));

    // a browser that says it isn't WebKit gets the blob: worker first; refused, the frame starts the data: one
    const fresh = await browser.newContext();
    await fresh.addInitScript(() => { Object.defineProperty(Navigator.prototype, "userAgentData", { value: { brands: [] }, configurable: true }); });
    const p2 = await fresh.newPage();
    const coep = [];
    p2.on("console", (m) => { if (/Cross-Origin-Embedder-Policy/.test(m.text())) coep.push(m.text().slice(0, 120)); });
    await p2.goto(`${dev.site}/s/${id}`);
    await p2.waitForFunction(() => !!window.shared && !!document.querySelector("#nb .cell"), null, { timeout: 60000 });
    await p2.click("#runall");
    await p2.waitForFunction(() => (document.querySelector("#nb .cell .out")?.textContent ?? "").trim() === "42", null, { timeout: 60000 }).catch(() => {});
    const out2 = await p2.evaluate(() => (document.querySelector("#nb .cell .out")?.textContent ?? "").trim());
    ok(coep.length > 0 && out2 === "42" && p2.workers().filter((w) => w.url().startsWith("data:")).length === 1, `the blob: worker refused (${coep.length} COEP refusals), the data: one runs the notebook: ${J(out2)}`);
    await fresh.close();
  }
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser?.close();
  await dev.close();
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
