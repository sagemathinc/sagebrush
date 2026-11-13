// ci: web-runner order=484 chrome
// The account spot (web/workspace/signin-cta.ts), in headless Chromium against the built site, with the site's
// sign-in answers stood in by the browser itself (the DevTools Fetch domain: /api/share/me and /auth/logout):
//  - signed out (401): a Sign in button at the foot of the Files panel, with its person icon; one question per page;
//  - its dialog: the title, the reasons, Not now (closes, the button stays, nothing remembered), Esc, a click outside,
//    and the way in: /auth/login with this page to come back to;
//  - the Files panel hidden: a green Sign in pill in the corner (the notebook page's, the board page's own) that opens
//    the same dialog; shown again, the pill hides;
//  - signed in (200): the chip (an initial, the name), its aria-label; its menu (who, the email, Sign out), Esc and a
//    click outside; with no name, the email once; with neither, "Your account";
//  - Sign out: a POST to /auth/logout, a reload, and the one-time line after it;
//  - a site without sign-in (404), an error (500) or no answer: nothing; ?signin-demo on a 404 only;
//  - a 400 px window: the button across the panel.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-signin-cta.mjs
// (on another port: SB_URL=http://127.0.0.1:PORT/, with its slash)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-signin-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", detached: true });
const port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
// (the stood-in server: what /api/share/me answers now, and every request it saw)
const server = { me: { status: 401 }, seen: [] };
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
  if (m.method === "Fetch.requestPaused") {
    const { requestId, request } = m.params, path = new URL(request.url).pathname;
    server.seen.push({ path, method: request.method });
    const r = path === "/auth/logout" ? { status: 200, body: JSON.stringify({ ok: true }) } : server.me.status === 0 ? null : { status: server.me.status, body: server.me.body ?? JSON.stringify({ error: "sign in first" }) };
    if (!r) send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
    else send("Fetch.fulfillRequest", { requestId, responseCode: r.status, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(r.body).toString("base64") });
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const go = async (url) => { await send("Page.navigate", { url }); await sleep(300); await until(`document.readyState === "complete"`, 30000); };
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400)}`); if (!ok) fails.push(what); };

const ADA = { account_id: "8f3a1c2e-0000-4000-8000-00000000ada0", name: "Ada Lovelace", email: "ada@example.org" };
const as = (status, me) => { server.me = { status, body: me ? JSON.stringify(me) : undefined }; };
const filesShown = () => ev(`document.body.classList.contains("wsfiles")`);
const setFiles = async (want) => { if ((await filesShown()) !== want) { await ev(`document.querySelector(".sb-files-toggle").click()`); await sleep(500); } return filesShown(); };
const spot = () => ev(`(() => { const s = document.querySelector(".sbfiles .facct"); if (!s) return null;
  const b = s.querySelector(".fsignin"), c = s.querySelector(".fchip"), r = (s.querySelector(".fsignin, .fchip") ?? s).getBoundingClientRect(), side = document.querySelector(".sbfiles").getBoundingClientRect();
  return { hidden: s.hidden, button: b ? b.textContent.trim() : null, icon: !!b?.querySelector("svg"), chip: c ? c.textContent.trim() : null, label: c?.getAttribute("aria-label") ?? null, line: s.querySelector(".fsignedout")?.textContent ?? null, w: Math.round(r.width), sideW: Math.round(side.width) }; })()`);
const rail = () => ev(`(() => { const b = document.querySelector(".sbacctrail"); if (!b) return null; const shown = !b.hidden && getComputedStyle(b).display !== "none" && b.getBoundingClientRect().width > 0;
  return { shown, pill: b.classList.contains("pill"), text: b.textContent.trim(), label: b.getAttribute("aria-label"), bg: getComputedStyle(b).backgroundColor, corner: b.parentElement?.id ?? null }; })()`);
const dialog = () => ev(`(() => { const d = document.querySelector("dialog.sbsignin[open]"); if (!d) return null; const a = d.querySelector(".acts a");
  return { title: d.querySelector("h2").textContent, reasons: [...d.querySelectorAll("li")].map((l) => l.textContent), go: a.textContent, href: a.getAttribute("href"), later: d.querySelector(".acts button").textContent, note: d.querySelector(".note").textContent, focus: document.activeElement === a }; })()`);
const menu = () => ev(`(() => { const m = document.querySelector(".sbacctmenu"); if (!m) return null; return { who: m.querySelector(".who")?.textContent ?? null, em: m.querySelector(".em")?.textContent ?? null, items: [...m.querySelectorAll("[role=menuitem]")].map((i) => i.textContent), focus: m.contains(document.activeElement) }; })()`);
const meCount = () => server.seen.filter((s) => s.path === "/api/share/me").length;
const key = async (k) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0 }); await sleep(200); };
const clickAt = async (x, y) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); await sleep(250); };

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  // (each place in the page's code that asks /api/share/me, and how often: from the first frame past fetch itself)
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const f = window.fetch; window.__meSites = {};
    window.fetch = function (u, o) { if (String(u?.url ?? u).includes("/api/share/me")) { const at = (new Error().stack ?? "").split("\\n")[2]?.trim() ?? "?"; window.__meSites[at] = (window.__meSites[at] ?? 0) + 1; } return f.call(this, u, o); }; })()` });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/share/me*", requestStage: "Request" }, { urlPattern: "*/auth/logout*", requestStage: "Request" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // ---- signed out
  as(401);
  await go(base);
  await until(`!!window.sagebrush?.workspace`, 60000);
  await setFiles(true);
  await until(`!!document.querySelector(".sbfiles .facct .fsignin")`);
  let s = await spot();
  check(s && !s.hidden && s.button === "Sign in" && s.icon && s.chip === null, "signed out: a Sign in button, with its person icon, at the foot of the Files panel", s);
  check(s && s.w >= s.sideW - 24, "...across the panel", s);
  // (the page's sync also asks who's signed in, from its own place in the code: so count by the place asking)
  const sites = await ev(`window.__meSites`);
  check(meCount() >= 1 && Object.values(sites ?? {}).every((n) => n === 1), "one question per page, for the panel and the corner both", { sites, n: meCount() });
  await ev(`document.querySelector(".fsignin").click()`);
  let d = await dialog();
  check(d && d.title === "Sign in to sync and publish" && d.reasons.length === 2 && d.reasons[0].startsWith("Sync your notebooks between your browsers and devices.") && d.reasons[1].startsWith("Publish a notebook or a talk") && d.go === "Sign in with CoCalc" && d.later === "Not now" && d.note === "Sagebrush uses your CoCalc account. Making one is free.", "the dialog: its title, two reasons, its buttons and its note", d);
  const here = await ev(`location.pathname + location.search + location.hash`);
  check(d && d.href === "/auth/login?return=" + encodeURIComponent(here) && d.focus, "...the way in is /auth/login, back to this page, and has the focus", { href: d?.href, here });
  await ev(`[...document.querySelectorAll("dialog.sbsignin .acts button")].find((b) => b.textContent === "Not now").click()`);
  check(!(await dialog()) && (await spot())?.button === "Sign in", "Not now closes it, and the button stays");
  await ev(`document.querySelector(".fsignin").click()`); await key("Escape");
  check(!(await dialog()), "Esc closes it");
  await ev(`document.querySelector(".fsignin").click()`); await clickAt(1250, 400);
  check(!(await dialog()), "a click outside closes it");
  await go(base); await until(`!!document.querySelector(".sbfiles .facct .fsignin")`);
  check((await spot())?.button === "Sign in", "after a reload the button is still there: Not now remembered nothing");

  // ---- the corner, the files hidden: the notebook page's own corner, then the board page's
  await setFiles(false);
  let r = await rail();
  check(r && r.shown && r.pill && r.text === "Sign in" && r.corner === "sbcorner" && r.bg !== "rgba(0, 0, 0, 0)", "files hidden: a green Sign in pill in the notebook page's corner", r);
  await ev(`document.querySelector(".sbacctrail").click()`);
  check(!!(await dialog()), "...which opens the same dialog");
  await key("Escape");
  await setFiles(true);
  check(!(await rail())?.shown, "files shown again: the pill hides (the panel's button is the spot)");
  await go(base + "board/"); if (!(await until(`!!window.sagebrush?.board`, 60000))) console.log("board: no window.sagebrush.board", await ev(`location.href`));
  await setFiles(false); await until(`!!document.querySelector("#sbacctcorner .sbacctrail:not([hidden])")`);
  r = await rail();
  check(r && r.shown && r.pill && r.corner === "sbacctcorner", "the board page, files hidden: the pill in a corner of its own", r);
  await ev(`document.querySelector(".sbacctrail").click()`);
  check(!!(await dialog()), "...which opens the same dialog"); await key("Escape");
  await setFiles(true);
  check(!(await rail())?.shown && (await spot())?.button === "Sign in", "the board page, files shown: the corner hides and the panel has the button");

  // ---- signed in
  as(200, ADA);
  await go(base); await until(`!!window.sagebrush?.workspace`, 60000); await setFiles(true);
  await until(`!!document.querySelector(".sbfiles .facct .fchip")`);
  s = await spot();
  check(s && s.chip === "AAda Lovelace⌃" && s.label === "Account: Ada Lovelace, menu" && s.button === null, "signed in: the chip, an initial and the name, its aria-label", s);
  await ev(`document.querySelector(".fchip").click()`);
  let mm = await menu();
  check(mm && mm.who === "Signed in as Ada Lovelace" && mm.em === "ada@example.org" && mm.items.join("|") === "Sign out" && mm.focus, "its menu: who, the email, Sign out (and the focus in it)", mm);
  check((await ev(`document.querySelector(".fchip").getAttribute("aria-expanded")`)) === "true", "...the chip says it's open");
  await key("Escape");
  check(!(await menu()) && (await ev(`document.activeElement?.classList.contains("fchip")`)), "Esc closes it, the focus back on the chip");
  await ev(`document.querySelector(".fchip").click()`); await sleep(150); await clickAt(900, 300);
  check(!(await menu()), "a click elsewhere closes it");
  await setFiles(false);
  r = await rail();
  check(r && r.shown && !r.pill && r.text === "A" && r.label === "Account: Ada Lovelace, menu", "files hidden, signed in: the initial in the corner", r);
  await ev(`document.querySelector(".sbacctrail").click()`);
  check((await menu())?.who === "Signed in as Ada Lovelace", "...which opens the same menu"); await key("Escape");
  await setFiles(true);
  as(200, { account_id: ADA.account_id, email: ADA.email });
  await go(base); await until(`!!document.querySelector(".sbfiles .facct .fchip")`);
  await ev(`document.querySelector(".fchip").click()`);
  mm = await menu(); s = await spot();
  check(s?.chip === "Aada@example.org⌃" && mm?.who === "Signed in as ada@example.org" && mm.em === null, "no name: the email on the chip, and once in the menu", { s, mm });
  await key("Escape");
  as(200, { account_id: ADA.account_id });
  await go(base); await until(`!!document.querySelector(".sbfiles .facct .fchip")`);
  check((await spot())?.chip === "?Your account⌃", "neither name nor email: \"Your account\"", await spot());

  // ---- Sign out: a POST, a reload, the line once
  as(200, ADA);
  await go(base); await until(`!!document.querySelector(".sbfiles .facct .fchip")`);
  const before = server.seen.length;
  await ev(`document.querySelector(".fchip").click()`);
  as(401);
  await ev(`[...document.querySelectorAll(".sbacctmenu [role=menuitem]")].find((b) => b.textContent === "Sign out").click()`);
  await sleep(500);
  await until(`document.readyState === "complete" && !!document.querySelector(".sbfiles .facct .fsignin")`, 60000);
  const logout = server.seen.slice(before).filter((x) => x.path === "/auth/logout");
  check(logout.length === 1 && logout[0].method === "POST", "Sign out: one POST to /auth/logout", server.seen.slice(before));
  s = await spot();
  check(s?.button === "Sign in" && s.line === "Signed out. Your notebooks in this browser are still here; sync is off until you sign in again.", "after its reload: the Sign in button and the line, once", s);
  await go(base); await until(`!!document.querySelector(".sbfiles .facct .fsignin")`);
  check((await spot())?.line === null, "...not again after the next reload");

  // ---- no sign-in here, or no answer: nothing; ?signin-demo only on a 404
  for (const [status, what] of [[404, "a site without sign-in (404)"], [500, "an error (500)"], [0, "no answer"]]) {
    as(status);
    await go(base); await until(`!!window.sagebrush?.workspace`, 60000); await sleep(1500);
    const sp = await spot(), rl = await rail();
    check(sp && sp.hidden && !rl?.shown, `${what}: no button, no chip, no pill`, { sp, rl });
  }
  as(404);
  await go(base + "?signin-demo"); await until(`!!document.querySelector(".sbfiles .facct .fsignin")`);
  check((await spot())?.button === "Sign in", "?signin-demo on a site without sign-in: the signed-out look");
  await go(base + "?signin-demo=in"); await until(`!!document.querySelector(".sbfiles .facct .fchip")`);
  check((await spot())?.chip === "AAda Lovelace⌃", "?signin-demo=in: the signed-in look");
  as(200, ADA);
  await go(base + "?signin-demo"); await until(`!!document.querySelector(".sbfiles .facct .fchip")`);
  check((await spot())?.chip === "AAda Lovelace⌃", "?signin-demo on a site with sign-in changes nothing (signed in stays signed in)");
  as(401);
  await go(base + "?signin-demo=in"); await until(`!!document.querySelector(".sbfiles .facct .fsignin")`);
  check((await spot())?.button === "Sign in", "...nor ?signin-demo=in (signed out stays signed out)");

  // ---- a 400 px window
  await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: true });
  await go(base); await until(`!!document.querySelector(".sbfiles .facct .fsignin")`);
  s = await spot();
  check(s && s.w >= s.sideW - 24 && s.w <= 400, "a 400 px window: the button across the panel", s);

  check(errors.length === 0, "no uncaught exceptions", errors.slice(0, 3));
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
  rmSync(profile, { recursive: true, force: true });
}
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: ${checks} checks`);
process.exit(0);
