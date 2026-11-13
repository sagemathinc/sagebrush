// ci: none (needs Playwright's Firefox: run by hand until ci.yml's webkit job runs it with BROWSER=firefox)
// Code runs in the sandboxed runner in Firefox as in Chromium (web/notebook/runner-browser.js, web/csp.ts): against the
// share API in Miniflare (web/share/serve-dev.mjs) and web/dist, in a fresh profile,
//   1. a shared notebook's page: Run all runs it, in the runner frame (sandbox="allow-scripts", no plain worker), whose
//      origin is opaque, with no storage, no cookies and no reach into the page; the runner's page says CORP;
//   2. the notebook page: a new notebook's cell runs, in the runner frame, never refused for want of one ("This
//      notebook can't run here", what Firefox said on every cell before: no runner was tried outside Chromium).
//   BROWSER=firefox|chromium PLAYWRIGHT=<playwright's dir> node web/test-runner-engines.mjs   (CHROME=... for chromium)
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { startDev } from "./share/serve-dev.mjs";

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
} catch (e) {
  failures++;
  console.log("FAIL", e.message);
} finally {
  await browser?.close();
  await dev.close();
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
