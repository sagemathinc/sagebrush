// ci: web-sync.2 order=59 chrome
// The approval page in a real browser: headless Chromium against the remotes' Worker (web/cloud/remote/test-entry.ts)
// in Miniflare, over HTTP.  The other suites set a request's Origin by hand; here the browser sets it, as it does for a
// person: the page's form posts must carry the page's own origin, or the same-site check (sameSite()) refuses them as
// "cross-site request".  Under the pages' old Referrer-Policy, no-referrer, Chromium sends `Origin: null` on a form
// POST, and every approval was refused (DEV, Nov 12).
//   0. the control: the pages served as they were (no-referrer, test-entry's /__referrer hook), the same submit is
//      refused, {"error":"cross-site request"}, no remote, the device still pending; so the rows below have teeth;
//   1. the page is served with Referrer-Policy: same-origin;
//   2. signed in, the code typed and Continue pressed: the confirmation, not "cross-site request";
//   3. Approve pressed: "Approved", the remote enrolled to the account.
//   node web/cloud/remote/test-remote-browser.mjs
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { migrations } from "../share/migrations.mjs";
import { devtoolsPort } from "../../test-port.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../site/package.json"));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const A = "11111111-1111-4111-8111-111111111111";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };

const script = execFileSync("bun", ["build", join(here, "test-entry.ts"), "--format", "esm", "--target", "browser", "--external", "cloudflare:workers"], { encoding: "utf8" });
const bindings = { SESSION_KEY: "session-key", SHARE_DEV: "1", DEV_AUTH_TOKEN: "dev-token", REMOTE_CHAL_KEY: "chal-key", REMOTE_ACCOUNTS: A };
const mf = new Miniflare(convertV4MiniflareOptions({
  host: "127.0.0.1", port: 0,
  workers: [{ name: "remote", modules: true, script, compatibilityDate: "2026-10-01", d1Databases: ["SHARE_DB"], r2Buckets: ["SHARE_BUCKET"], bindings }],
}));
const profile = mkdtempSync(join(tmpdir(), "sb-remote-browser-"));
let chrome = null;
try {
  // (localhost, not 127.0.0.1: the session cookie is __Host- and Secure, which Chromium keeps over plain HTTP for
  // localhost)
  const base = (await mf.ready).href.replace("127.0.0.1", "localhost").replace(/\/$/, "");
  const db = await mf.getD1Database("SHARE_DB");
  for (const { path: m } of migrations())
    for (const s of readFileSync(m, "utf8").replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(s).run();
  const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  // (a session for A, from web/share's /auth/dev; a device waiting for approval, as `sagebrush remote login` starts one)
  const r = await post("/auth/dev", { token: "dev-token", account_id: A }, { origin: base });
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("__Host-sb_session="));
  ok(!!cookie, `a session (${r.status})`);
  const device = async (name) => {
    const k = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const { kty, crv, x, y } = await webcrypto.subtle.exportKey("jwk", k.publicKey);
    const d = await (await post("/api/remote/v1/device", { pub: { kty, crv, x, y }, kind: "runner", name })).json();
    ok(/^[A-Z]{4}-[A-Z]{4}$/.test(d.user_code ?? ""), `a device code for ${name} (${d.user_code})`);
    return d;
  };
  const remotesOf = async (name) => (await db.prepare("SELECT account FROM remotes WHERE name = ?1").bind(name).all()).results.map((x) => x.account);
  const stateOf = async (code) => (await db.prepare("SELECT state FROM remote_devices WHERE user_code = ?1").bind(code.replace("-", "")).first())?.state;
  chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const cdpPort = await devtoolsPort(profile, 60_000, { child: chrome });
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json(); break; } catch { await sleep(100); } }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++n; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const text = () => ev("document.body ? document.body.innerText : ''");
  // (the session, as the browser would hold it after signing in)
  const [name, value] = cookie.split(/=(.*)/s);
  const set = await send("Network.setCookie", { name, value, url: base + "/", path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
  ok(set?.success === true, "the session cookie is set in the browser");

  // (the page; the code typed; Continue pressed, as a person does)
  const submit = async (code) => {
    await send("Page.navigate", { url: base + "/remote/activate" });
    const shown = await until("!!document.querySelector('input[name=code]')");
    await ev(`(() => { document.querySelector('input[name=code]').value = ${JSON.stringify(code)}; document.querySelector('form button').click(); return 1; })()`);
    await until("!!document.querySelector('button[value=approve]') || /cross-site|error/i.test(document.body?.innerText ?? '')");
    return { shown, text: await text() };
  };

  // (0) the control: the pages as they were, no-referrer: the browser's POST carries Origin: null, refused
  ok((await (await fetch(base + "/__referrer?policy=no-referrer")).json()).policy === "no-referrer", "control: the pages served with no-referrer");
  const cd = await device("control-box");
  const c = await submit(cd.user_code);
  ok(c.shown && c.text.includes('"cross-site request"') && (await remotesOf("control-box")).length === 0 && (await stateOf(cd.user_code)) === "pending",
    `control: under no-referrer, Continue is refused as cross-site, no remote, the device pending (${JSON.stringify(c.text.slice(0, 80))})`);
  ok((await (await fetch(base + "/__referrer?policy=")).json()).policy === "", "control over: the pages' own header again");

  // (1) the page's own header, as the browser gets it
  const dev = await device("browser-box");
  const g = await fetch(base + "/remote/activate", { headers: { cookie } });
  ok(g.status === 200 && g.headers.get("referrer-policy") === "same-origin", `the page: Referrer-Policy same-origin (${g.status}, ${g.headers.get("referrer-policy")})`);

  // (2) Continue: the confirmation
  const { shown, text: t2 } = await submit(dev.user_code);
  ok(shown, "the page shows the code form");
  ok(!/cross-site/.test(t2) && (await ev("!!document.querySelector('button[value=approve]')")), `Continue: the confirmation, not refused (${JSON.stringify(t2.slice(0, 120))})`);

  // (3) Approve pressed: approved, the remote the account's
  await ev("(() => { document.querySelector('button[value=approve]').click(); return 1; })()");
  const done = await until("/Approved|cross-site|error/i.test(document.body?.innerText ?? '') && !document.querySelector('button[value=approve]')");
  const t3 = await text();
  const rows = await remotesOf("browser-box");
  ok(done && /Approved/.test(t3) && JSON.stringify(rows) === JSON.stringify([A]), `Approve: approved, the remote the account's (${JSON.stringify(t3.slice(0, 120))}, ${JSON.stringify(rows)})`);
  ws.close();
} catch (e) {
  ok(false, "threw: " + (e?.stack ?? e));
} finally {
  // (the profile is removed only once Chrome has exited: it writes there on its way out, and a profile removed under it
  // fails ENOTEMPTY; SIGKILL if SIGTERM hasn't ended it in 5 s)
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const gone = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    if (!(await Promise.race([gone.then(() => true), sleep(5000).then(() => false)]))) { chrome.kill("SIGKILL"); await gone; }
  }
  await mf.dispose();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
