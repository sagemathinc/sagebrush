// ci: none (test-support.mjs runs it, in web-sync.1)
// The support page's script in headless Chromium (the addendum to plan-support-requests r12, sections 2 and 6.5):
// an agent's draft in the fragment, #draft=<base64url of {"v":1,"kind","title","description"}>, fills the form once and
// is cleared; any other key (send, submit, email) is ignored, and a draft that isn't valid leaves the form empty; and
// only the person's own (trusted) click on Send sends: a script's requestSubmit() or dispatched submit sends nothing.
// The page is page.ts's own (handlePage), served here with a stub Turnstile and the API recorded.
//   bun web/cloud/support/test-support-page.mjs     (CHROME=<binary>: else google-chrome where installed, or chromium; test-support.mjs
//                                              runs it, so CI does)
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { handlePage } from "./page.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0, count = 0;
const ok = (c, what) => { count++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) failures++; };

const env = { TURNSTILE_SITE_KEY: "0x4AAAAAAA-site-key" };
const posts = [];
const web = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/api/v1/requests" && req.method === "POST") {
    posts.push({ headers: Object.fromEntries(req.headers), body: await req.text() });
    return Response.json({ ref: "R1" });
  }
  return handlePage(req, env) ?? new Response("not found", { status: 404 });
} });
const origin = `http://127.0.0.1:${web.port}`;

const profile = mkdtempSync(join(tmpdir(), "sb-support-page-"));
const chrome = spawn(process.env.CHROME ?? (["/usr/bin/google-chrome", "/opt/google/chrome/chrome"].some(existsSync) ? "google-chrome" : "chromium"), ["--headless", "--no-sandbox", "--password-store=basic", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let port;
for (let i = 0; i < 300 && !port; i++) { const f = join(profile, "DevToolsActivePort"); if (existsSync(f)) port = Number(readFileSync(f, "utf8").split("\n")[0]); else await sleep(100); }
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (sock.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
// (Turnstile's script, stubbed: a widget whose callback hands over a token at once)
const TURNSTILE = `window.turnstile = { render: function (el, o) { setTimeout(function () { o.callback("tok-" + Math.random()); }, 10); return 1; }, reset: function () {} };`;
sock.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Fetch.requestPaused") send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/javascript" }], body: Buffer.from(TURNSTILE).toString("base64") });
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); sock.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };

const center = (id) => ev(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const click = async (id) => { const at = await center(id); for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 }); };
const key = async (k) => { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: { " ": "Space" }[k] ?? k, windowsVirtualKeyCode: { Enter: 13, " ": 32, Tab: 9 }[k], ...(k === "Enter" && type === "keyDown" ? { text: "\r" } : {}) }); };
const b64url = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const draft = (o) => "#draft=" + b64url(JSON.stringify(o));
const fields = () => ev(`({ kind: form.kind.value, title: form.title.value, description: form.description.value, email: form.email.value, hash: location.hash, status: document.getElementById("status").textContent })`);
const open = async (frag) => {
  // (by way of about:blank: from the page itself, a new fragment is a same-document navigation, and the script doesn't run)
  await send("Page.navigate", { url: "about:blank" });
  await sleep(100);
  await send("Page.navigate", { url: origin + "/" + frag });
  await until(`document.readyState === "complete" && !!window.turnstile && !!document.getElementById("form")`);
  await sleep(300);
};
const GOOD = { v: 1, kind: "pkg", title: "Missing package: networkx", description: "I tried import networkx in a Python cell: ModuleNotFoundError. Ünïcødé ✓." };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://challenges.cloudflare.com/*" }] });

  // a draft: the fields filled, the fragment cleared, the person told
  await open(draft(GOOD));
  let f = await fields();
  ok(f.kind === "pkg" && f.title === GOOD.title && f.description === GOOD.description, `a draft fills kind, title and description, UTF-8 intact (${JSON.stringify(f).slice(0, 160)})`);
  ok(f.hash === "" && (await ev("location.href")) === origin + "/", "the fragment is cleared at once (history.replaceState)");
  ok(/An agent drafted this request/.test(f.status), "the page says an agent drafted it, to review before sending");
  ok(f.email === "", "no email from a draft");
  await sleep(1000);
  ok(posts.length === 0, "nothing is sent on load");

  // a script's submit sends nothing; the person's click sends once
  for (const [js, what] of [["form.requestSubmit()", "requestSubmit()"], ['form.dispatchEvent(new Event("submit", { cancelable: true }))', "a dispatched submit"], ['document.getElementById("send").click()', "the button's click()"]]) {
    await ev(`(() => { ${js}; return true; })()`);
    await sleep(500);
    ok(posts.length === 0, `a script's ${what} sends nothing`);
  }
  // (the window's user activation isn't consent to Send: astra's SUPPORT-DRAFT-1. After the person clicks the title
  // field, a script's requestSubmit() or send.click() still sends nothing, nor does Enter in the field)
  await click("title");
  for (const [js, what] of [["form.requestSubmit()", "requestSubmit()"], ['document.getElementById("send").click()', "send.click()"]]) {
    ok(await ev("navigator.userActivation.isActive"), `(the window has the person's activation before ${what})`);
    await ev(`(() => { ${js}; return true; })()`);
    await sleep(500);
    ok(posts.length === 0, `after the person clicks the title field, a script's ${what} sends nothing`);
  }
  await key("Enter");
  await sleep(500);
  ok(posts.length === 0, "Enter in the title field (a form submit) sends nothing");
  await click("send");
  ok(await until(`/Request received: #R1/.test(document.getElementById("status").textContent)`), "the person's click on Send sends it");
  ok(posts.length === 1 && JSON.stringify(JSON.parse(posts[0].body)) === JSON.stringify({ kind: GOOD.kind, title: GOOD.title, description: GOOD.description }) && /^tok-/.test(posts[0].headers["x-turnstile-token"]), `once, the draft as reviewed, with a Turnstile token (${posts.length} sent)`);

  ok((await ev(`document.getElementById("send").type`)) === "button" && !(await ev(`!!document.querySelector("#form [type=submit], #form button:not([type])")`)), "Send is a type=\"button\": the form has no submit button");
  // the keyboard: Send focused, Enter (and Space) send
  for (const k of ["Enter", " "]) {
    posts.length = 0;
    await open(draft(GOOD));
    // (to Send as a person gets there: a click in the email field, then Tab)
    await click("email");
    await key("Tab");
    ok((await ev("document.activeElement.id")) === "send", "(Tab from the email field reaches Send)");
    await key(k);
    ok(await until("/Request received/.test(document.getElementById(\"status\").textContent)", 5000) && posts.length === 1, `the keyboard: Tab to Send, then ${k === " " ? "Space" : "Enter"}, sends once (${posts.length})`);
  }

  // keys other than the four are ignored: send, submit and email don't send or fill anything
  posts.length = 0;
  await open(draft({ ...GOOD, send: 1, submit: true, email: "agent@example.com", autosend: "1" }));
  f = await fields();
  await sleep(1000);
  ok(f.title === GOOD.title && f.email === "" && posts.length === 0, `send, submit and email in a draft are ignored: filled, no email, nothing sent (${posts.length})`);

  // a draft that isn't valid: the form stays empty, the fragment is still cleared
  for (const [frag, why] of [
    [draft({ ...GOOD, v: 2 }), "an unknown v"],
    [draft({ ...GOOD, kind: "urgent" }), "an unknown kind"],
    [draft({ ...GOOD, title: "Hi" }), "a title too short"],
    [draft({ ...GOOD, description: "x".repeat(200_000) }), "a description too long"],
    [draft({ ...GOOD, title: 5 }), "a title not a string"],
    ["#draft=%%%not-base64", "not base64url"],
    ["#draft=" + Buffer.from([0xff, 0xfe, 0x7b]).toString("base64url"), "not UTF-8"],
    ["#draft=" + b64url("[1,2]"), "not an object"],
  ]) {
    await open(frag);
    f = await fields();
    ok(f.title === "" && f.description === "" && f.hash === "" && f.status === "", `${why}: the form stays empty, the fragment cleared`);
  }
  // another fragment is left alone
  await open("#other=1");
  ok((await fields()).hash === "#other=1" && (await fields()).title === "", "a fragment that isn't #draft= is left as it is");
  ok(posts.length === 0, "and none of these sent anything");
  ok(errors.length === 0, "no exceptions in the page: " + errors.slice(0, 3).join(" | "));
} catch (e) {
  ok(false, "threw: " + String(e?.stack ?? e).slice(0, 600));
} finally {
  try { chrome.kill(); } catch {}
  web.stop(true);
  await sleep(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures ? `${failures} of ${count} failed` : `all ${count} passed`);
process.exit(failures ? 1 : 0);
