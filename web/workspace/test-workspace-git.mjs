// ci: web-runner order=193 runner=bun chrome
// An agent's branch's history and its review (W3 PR A), with its cases in git-cases.js: one tab's rows, then the row
// that needs a second tab (a decision in one tab wakes a git_wait in another), in one Chrome profile.
//   CHROME=google-chrome bun web/workspace/test-workspace-git.mjs        (ONLY=loop,wait for some cases; SHOW=1 every check)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const site = mkdtempSync(join(tmpdir(), "sb-ws-git-site-"));
writeFileSync(join(site, "entry.ts"), [
  `export * from ${JSON.stringify(join(here, "index.ts"))};`,
  `export * from ${JSON.stringify(join(here, "git-branch.ts"))};`,
  `export * from ${JSON.stringify(join(here, "branch-rules.ts"))};`,
  `export * from ${JSON.stringify(join(here, "git-verbs.ts"))};`,
  `export * from ${JSON.stringify(join(here, "review-actions.ts"))};`,
  `export { openBranchStore, refOf, objectId } from ${JSON.stringify(join(here, "branch-store.ts"))};`,
  `export { PAGE_VERBS } from ${JSON.stringify(join(here, "verbs-page.ts"))};`,
  `export { VERBS } from ${JSON.stringify(join(here, "verbs.ts"))};`,
].join("\n"));
const built = await Bun.build({ entrypoints: [join(site, "entry.ts")], outdir: site, naming: "ws.js", target: "browser", format: "esm" });
if (!built.success) {
  console.error(built.logs.join("\n"));
  process.exit(1);
}
copyFileSync(join(here, "git-cases.js"), join(site, "cases.js"));
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>git test</title><script type="module">import { run, steps } from "./cases.js"; window.run = run; window.B = steps; window.ready = true;</script>`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
  const p = new URL(req.url).pathname;
  if (!["/", "/ws.js", "/cases.js"].includes(p)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(join(site, p === "/" ? "index.html" : p.slice(1))), { headers: { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" } });
} });
const url = `http://127.0.0.1:${server.port}/`;

let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-ws-git-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); if (process.env.SHOW) console.log((ok ? "  ok   " : "  FAIL ") + what); };

/** A tab: opened on the test page, evaluated in, closed. */
async function tab() {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") fails.push("page error: " + (m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails)).slice(0, 500));
  };
  const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 2000)); return r.result?.value; };
  await send("Runtime.enable");
  for (let i = 0; i < 200 && !(await ev("window.ready === true").catch(() => false)); i++) await sleep(50);
  const B = (f, ...args) => ev(`window.B.${f}(${args.map((a) => JSON.stringify(a)).join(",")})`);
  const close = async () => { try { ws.close(); } catch {} await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); await sleep(300); };
  return { ev, B, close };
}

let code = 1;
try {
  if (!port) port = await devtoolsPort(profile);
  for (let i = 0; i < 300; i++) { try { await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch {} await sleep(100); }
  if (!process.env.ONLY_TABS) {
    const one = await tab();
    const results = await one.ev(`window.run(${process.env.ONLY ? JSON.stringify(process.env.ONLY.split(",")) : "undefined"}, ${JSON.stringify((process.env.SKIP ?? "").split(",").filter(Boolean))})`);
    for (const [ok, what] of results) { if (/^\(\w+: \d+ ms\)$/.test(what)) { console.log("  " + what); continue; } check(ok, what); }
    await one.close();
  }
  if (!process.env.ONLY) {
    // (ENGINE E4, the other tab: a git_wait in tab A, the person's decision in tab B; A wakes, through the channel)
    const a = await tab(), b = await tab();
    await a.B("open", "x1"); await a.B("seed");
    await b.B("open", "x1");
    await a.B("wait");
    await sleep(300);
    check((await a.B("waited")) === null, "tab A waits");
    await b.B("decide");
    let got = null;
    for (let i = 0; i < 80 && !got; i++) { got = await a.B("waited"); if (!got) await sleep(25); }
    check(got?.decided === true && got.status === "accepted", `a decision in tab B wakes tab A's git_wait: ${JSON.stringify(got)}`);
    await a.close(); await b.close();
  }
  if (fails.length) console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  else { console.log(`ok: an agent's branch's history and review, ${checks} checks`); code = 0; }
} finally {
  chrome.kill();
  server.stop(true);
  await sleep(200);
  rmSync(profile, { recursive: true, force: true });
  rmSync(site, { recursive: true, force: true });
}
process.exit(code);
