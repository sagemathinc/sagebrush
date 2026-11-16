// ci: web-runner order=484 chrome
// The account at the foot of the files, bottom left (web/workspace/browser.ts), and the Storage panel's sync section
// signed out (web/workspace/sync-panel.ts), in headless Chromium against the built site, at a desktop width and a
// phone width. The site's account answers
// (/api/share/me, /api/sync/v1/status, /auth/logout) are given by this test (CDP Fetch), as a signed-out, a signed-in or
// a no-accounts site:
//  - no accounts (the answer the CLI's page gives: not found): no account row, and nothing kept for it;
//  - signed out: "Sign in", to the site's sign-in and back to this page;
//  - signed in: the name (the email as its title), a menu (sync, the Storage panel, Sign out); Sign out signs out and
//    reloads the page;
//  - File ▸ Open…'s browser, closed before its account is answered and opened again: it never writes the sidebar's
//    height (--sb-acct-h), keeps no observer, and the late answer draws nothing into the closed dialog;
//  - the page's lower-left corner (theme, full screen) never over the account row: it sits in the files' foot row;
//  - on a phone, the account row above the toolbar at the window's foot, nothing over it;
//  - the Storage panel: its sync section says it is checking until sync's status is read, then, signed out, "Sign in"
//    (not the share dialog); its heading not under the Files button in the corner.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-account-item.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const profile = mkdtempSync(join(tmpdir(), "sb-account-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1280,860", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
// (the site's account, as this test answers it: "none" (not found, as a site without accounts), "out" (401) or "in";
// `hold`: the sync status asked for is left unanswered until released)
let mode = "none", hold = false, holdMe = false;
const held = [], heldMe = [], logouts = [];
const ME = { account_id: "5e5e5e5e-00d5-4e5e-8e5e-5e5e5e5e5ed5", name: "Ada Lovelace", email: "ada@example.org" };
const answer = (id, code, body) => send("Fetch.fulfillRequest", { requestId: id, responseCode: code, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(J(body)).toString("base64") });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? J(m.params.exceptionDetails));
  if (m.method === "Fetch.requestPaused") {
    const { requestId, request } = m.params, p = new URL(request.url).pathname;
    if (p === "/auth/logout") { logouts.push(request.method); mode = "out"; return void answer(requestId, 200, { ok: true }); }
    if (mode === "none") return void send("Fetch.continueRequest", { requestId });
    if (p === "/api/share/me" && holdMe) return void heldMe.push(requestId);
    if (p === "/api/share/me") return void (mode === "in" ? answer(requestId, 200, ME) : answer(requestId, 401, { error: "sign in first" }));
    if (p === "/api/sync/v1/status") {
      if (hold) return void held.push(requestId);
      return void answer(requestId, 401, { error: "sign in first" });
    }
    send("Fetch.continueRequest", { requestId });
  }
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(J({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(J(r.exceptionDetails).slice(0, 400)); return r.result?.value; };
const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; console.log((ok ? "ok   " : "FAIL ") + what + (ok || detail === undefined ? "" : " " + J(detail).slice(0, 400))); if (!ok) fails.push(what); };
// (the notebook page, loaded with the files shown, its account read)
const load = async () => {
  await ev(`localStorage.setItem("sagebrush-files-sidebar", "1")`).catch(() => {});
  await send("Page.navigate", { url: base }); await sleep(300);
  const ok = await until(`document.readyState === "complete" && !!document.querySelector("#wssidebar .facct") && !!window.sagebrush?.workspace`, 30000);
  await sleep(800);
  return ok;
};
const rect = (sel) => `(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`;
const disjoint = (a, b) => !!a && !!b && (a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
const storage = async () => {
  await ev(`document.querySelector("#wssidebar .fh button[aria-label=More]").click()`);
  await until(`[...document.querySelectorAll(".sbfmenu button")].some((x) => x.textContent === "Storage…")`, 5000);
  await ev(`[...document.querySelectorAll(".sbfmenu button")].find((x) => x.textContent === "Storage…").click()`);
};
const syncText = `([...document.querySelectorAll(".sbfprev h4")].find((h) => h.textContent === "Sync")?.parentElement?.innerText ?? "").replace(/\\s+/g, " ").trim()`;

try {
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Fetch.enable", { patterns: ["*/api/share/me*", "*/api/sync/v1/status*", "*/auth/logout*"].map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  await send("Page.navigate", { url: base }); await sleep(300);

  // ---- a site without accounts: nothing
  mode = "none";
  check(await load(), "the notebook page, the files shown");
  check(await ev(`document.querySelector("#wssidebar .facct").hidden && getComputedStyle(document.querySelector("#wssidebar .facct")).display === "none"`), "no accounts here (not found): no account row");
  check((await ev(`getComputedStyle(document.documentElement).getPropertyValue("--sb-acct-h").trim()`)) === "0px", "…and no room kept for it");

  // ---- signed out: Sign in, back to this page
  mode = "out";
  check(await load(), "signed out: loaded");
  const signin = await ev(`(() => { const a = document.querySelector("#wssidebar .facct a"); return a && { text: a.textContent, href: a.getAttribute("href"), want: "/auth/login?return=" + encodeURIComponent(location.pathname + location.search + location.hash) }; })()`);
  check(signin?.text === "Sign in" && signin.href === signin.want, "signed out: \"Sign in\" at the foot of the files, to the sign-in and back to this page", signin);
  const corner = await ev(rect("#sbcorner")), acct = await ev(rect("#wssidebar .facct")), foot = await ev(rect("#wssidebar .ffoot"));
  check(disjoint(corner, acct) && corner.top >= foot.top - 1 && corner.bottom <= foot.bottom + 1, "the lower-left corner (theme, full screen) sits in the files' foot row, never over the account", { corner, acct, foot });

  // ---- the Storage panel signed out: checking first, then Sign in (not Share)
  hold = true;
  await storage();
  check(await until(`${syncText} === "Sync Checking sync…"`, 8000), "the Storage panel: \"Checking sync…\" until sync's status is read", await ev(syncText).catch(() => null));
  hold = false;
  for (const id of held.splice(0)) await answer(id, 401, { error: "sign in first" });
  check(await until(`${syncText} === "Sync Sign in to use sync"`, 8000), "…then, signed out: \"Sign in to use sync\"", await ev(syncText).catch(() => null));
  check(await ev(`(() => { const a = [...document.querySelectorAll(".sbfprev .sync a")].find((x) => x.textContent === "Sign in"); return !!a && a.getAttribute("href") === "/auth/login?return=" + encodeURIComponent(location.pathname + location.search + location.hash); })()`), "…its Sign in is the sign-in itself, back to this page (no share dialog)");
  await ev(`document.querySelector(".sbfprev .ph .x").click()`);

  // ---- signed in: the name, its menu, Sign out
  mode = "in";
  check(await load(), "signed in: loaded");
  check(await ev(`(() => { const b = document.querySelector("#wssidebar .facctbtn"); return !!b && b.querySelector(".nm").textContent === "Ada Lovelace" && b.title === "ada@example.org" && b.querySelector(".av").textContent === "A"; })()`), "signed in: the name at the foot of the files, the email its title, its initial");

  // ---- File ▸ Open…'s browser: closed before its account is answered, then opened again
  const sideH = await ev(`getComputedStyle(document.documentElement).getPropertyValue("--sb-acct-h").trim()`);
  await ev(`(() => {
    window.__acctWrites = 0;
    const sp = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (n, ...a) { if (n === "--sb-acct-h") window.__acctWrites++; return sp.call(this, n, ...a); };
    window.__ro = [];
    const RO = ResizeObserver;
    window.ResizeObserver = class extends RO {
      constructor(cb) { super(cb); this.on = []; this.off = false; window.__ro.push(this); }
      observe(t, ...a) { this.on.push(t); return super.observe(t, ...a); }
      disconnect() { this.off = true; return super.disconnect(); }
    };
    return 1;
  })()`);
  const ctrlO = `(document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true })), 1)`;
  const liveDialogObservers = `window.__ro.filter((o) => !o.off && o.on.some((t) => !t.isConnected || t.closest(".sbfopen"))).length`;
  holdMe = true;
  await ev(ctrlO);
  const opened = await until(`!!document.querySelector(".sbfopen .sbfiles")`, 5000);
  for (let t = Date.now(); !heldMe.length && Date.now() - t < 5000; ) await sleep(50);
  check(opened && heldMe.length > 0, "File ▸ Open…: its browser, its account asked for", { opened, asked: heldMe.length });
  await ev(`(window.__dlgAcct = document.querySelector(".sbfopen .facct"), document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  check(await until(`!document.querySelector(".sbfopen")`, 5000), "…closed before the account's answer");
  for (const id of heldMe.splice(0)) await answer(id, 200, ME);
  await sleep(600);
  const late = await ev(`({ writes: window.__acctWrites, live: ${liveDialogObservers}, drawn: window.__dlgAcct ? window.__dlgAcct.childElementCount : -1, h: getComputedStyle(document.documentElement).getPropertyValue("--sb-acct-h").trim() })`);
  check(late.writes === 0 && late.h === sideH, "…the late answer: the sidebar's height (--sb-acct-h) never written by the dialog's browser", { late, sideH });
  check(late.live === 0, "…no observer kept for the closed dialog's account", late);
  check(late.drawn === 0, "…and nothing drawn into the closed dialog", late);
  holdMe = false;
  await ev(ctrlO);
  check(await until(`document.querySelector(".sbfopen .facctbtn .nm")?.textContent === "Ada Lovelace"`, 8000), "Open… again: its account shown");
  await ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await until(`!document.querySelector(".sbfopen")`, 5000);
  const after = await ev(`({ writes: window.__acctWrites, live: ${liveDialogObservers}, h: getComputedStyle(document.documentElement).getPropertyValue("--sb-acct-h").trim() })`);
  check(after.writes === 0 && after.live === 0 && after.h === sideH, "…and closed: still no write of the sidebar's height, no observer kept", { after, sideH });

  await ev(`document.querySelector("#wssidebar .facctbtn").click()`);
  await until(`!!document.querySelector(".sbfmenu")`, 3000);
  const items = await ev(`[...document.querySelectorAll(".sbfmenu button")].map((b) => b.textContent)`);
  check(J(items) === J(["Turn on sync…", "Storage and plan…", "Sign out"]), "its menu: sync (off here: Turn on sync…), Storage and plan…, Sign out", items);
  await ev(`window.__before = 1, 1`);
  await ev(`[...document.querySelectorAll(".sbfmenu button")].find((b) => b.textContent === "Sign out").click()`);
  check(await until(`!window.__before && document.readyState === "complete"`, 15000), "Sign out reloads the page");
  check(J(logouts) === J(["POST"]), "…after the site's sign-out (POST /auth/logout)", logouts);
  check(await until(`document.querySelector("#wssidebar .facct a")?.textContent === "Sign in"`, 15000), "…and the page is signed out: \"Sign in\"");

  // ---- a phone: the account above the toolbar, nothing over it; the Storage panel's heading clear of the Files button
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" });
  mode = "out";
  check(await load(), "a phone: loaded");
  check(await ev(`document.documentElement.classList.contains("phone")`), "…in the phone layout");
  const pa = await ev(rect("#wssidebar .facct")), bar = await ev(rect(".bar[role=toolbar]"));
  const covered = await ev(`(() => { const r = document.querySelector("#wssidebar .facct").getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !document.querySelector("#wssidebar .facct").contains(at) ? (at?.id || at?.className || at?.tagName) : null; })()`);
  check(!!pa && !!bar && pa.bottom <= bar.top + 1 && covered === null, "a phone: \"Sign in\" above the toolbar, nothing over it", { pa, bar, covered });
  await storage();
  await until(`!!document.querySelector(".sbfprev .ph b")`, 5000);
  const over = await ev(`(() => { const b = document.querySelector(".sbfprev .ph b"), r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + 4, r.top + r.height / 2); return at === b ? null : (at?.className || at?.tagName); })()`);
  check(over === null, "a phone: the Storage panel's heading, nothing over it (the Files button stays under the dialog)", over);
  check(errors.length === 0, "no uncaught exceptions", errors.slice(0, 3));
} catch (e) {
  check(false, "the test ran: " + (e?.stack ?? e));
} finally {
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: the account at the foot of the files, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
