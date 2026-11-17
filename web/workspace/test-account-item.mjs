// ci: web-runner order=484 chrome
// The account at the top right of the notebook and board pages' bars, beside Share (web/workspace/account.ts), the one
// place it is, and the Storage panel's sync section signed out (web/workspace/sync-panel.ts), in headless Chromium
// against the built site, at a desktop width and a phone width. The site's account answers (/api/share/me,
// /api/sync/v1/status, /auth/logout) are given by this test (CDP Fetch), as a signed-out, a signed-in or a
// no-accounts site:
//  - another answer (a 404, as the CLI's page gives): nothing in the bar;
//  - signed out: "Sign in" in the bar, right of Share, to the site's sign-in and back to this page; the files' foot has
//    no account;
//  - signed in: the initial, its title the name and email; its menu (who, Sync and storage…, Sign out); Escape closes
//    it; Sync and storage… opens the Storage panel; Sign out asks the server to sign out, then reloads;
//  - File > Open…'s dialog: no account in it;
//  - the Storage panel: its sync section says it is checking until sync's status is read, then, signed out, "Sign in";
//  - the board page: the same, signed out, signed in (its menu) and for a 404;
//  - on a phone: "Sign in" in the bar at the top, in the window, nothing over it.
// Serve web/dist first (python3 web/serve.py 8765), then
//   node web/workspace/test-account-item.mjs        (SHOTS=dir: also each state as a PNG, for a look)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// (the site's account, as this test answers it: "none" (404), "out" (401) or "in" (200);
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
// (a page loaded, its account read: the request answered, or the page settled without one)
const load = async (url = base) => {
  await send("Page.navigate", { url }); await sleep(300);
  const ok = await until(`document.readyState === "complete"`, 30000);
  await sleep(1500);
  return ok;
};
const shot = async (name) => { if (process.env.SHOTS) writeFileSync(join(process.env.SHOTS, name + ".png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64")); };
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

  const SLOT = "#acctslot";
  const signInWant = `"/auth/login?return=" + encodeURIComponent(location.pathname + location.search + location.hash)`;
  const shown = (sel) => `(() => { const e = document.querySelector(${J(sel)}); return !!e && !e.hidden && getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0; })()`;

  // ---- another answer (a 404): nothing
  mode = "none";
  check(await load() && await until(`!!window.sagebrush?.workspace`, 30000), "the notebook page");
  check(await ev(`!(${shown(SLOT)}) && document.querySelector(${J(SLOT)}).childElementCount === 0`), "a 404 from the endpoint: nothing in the bar");

  // ---- signed out: Sign in at the top right, right of Share, back to this page
  mode = "out";
  check(await load(), "signed out: loaded");
  check(await until(shown(SLOT + " a.sbacct-in"), 8000), "signed out: \"Sign in\" in the bar");
  const signin = await ev(`(() => { const a = document.querySelector("${SLOT} a"); return { text: a.textContent, href: a.getAttribute("href"), want: ${signInWant} }; })()`);
  await shot("notebook-signed-out");
  check(signin.text === "Sign in" && signin.href === signin.want, "…to the site's sign-in and back to this page", signin);
  const where = await ev(`(() => { const r = document.querySelector("${SLOT}").getBoundingClientRect(), h = document.querySelector("header").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right, w: innerWidth, hTop: h.top, hBottom: h.bottom, inHeader: !!document.querySelector("header ${SLOT}"), afterShare: !!(document.querySelector("#sharebtn").compareDocumentPosition(document.querySelector("${SLOT}")) & Node.DOCUMENT_POSITION_FOLLOWING) }; })()`);
  check(where.inHeader && where.afterShare && where.top >= where.hTop - 1 && where.bottom <= where.hBottom + 1 && where.right > where.w * 0.75, "…at the top right of the page's bar, right of Share", where);
  await ev(`localStorage.setItem("sagebrush-files-sidebar", "1")`);
  check(await load() && await until(`!!document.querySelector("#wssidebar .sbfiles")`, 15000), "the files shown");
  check(await ev(`!document.querySelector("#wssidebar .facct, #wssidebar .sbacct, #wssidebar a[href^='/auth/login']")`), "the files' foot has no account: one place for it, the bar");

  // ---- the Storage panel signed out: checking first, then Sign in (not Share)
  hold = true;
  await storage();
  check(await until(`${syncText} === "Sync Checking sync…"`, 8000), "the Storage panel: \"Checking sync…\" until sync's status is read", await ev(syncText).catch(() => null));
  hold = false;
  for (const id of held.splice(0)) await answer(id, 401, { error: "sign in first" });
  check(await until(`${syncText} === "Sync Sign in to use sync"`, 8000), "…then, signed out: \"Sign in to use sync\"", await ev(syncText).catch(() => null));
  check(await ev(`(() => { const a = [...document.querySelectorAll(".sbfprev .sync a")].find((x) => x.textContent === "Sign in"); return !!a && a.getAttribute("href") === ${signInWant}; })()`), "…its Sign in is the sign-in itself, back to this page (no share dialog)");
  await ev(`document.querySelector(".sbfprev .ph .x").click()`);

  // ---- signed in: the initial, its menu, Sync and storage, Sign out
  mode = "in";
  check(await load(), "signed in: loaded");
  check(await until(shown(SLOT + " .sbacct-btn"), 8000), "signed in: the account's button in the bar");
  const btn = await ev(`(() => { const b = document.querySelector("${SLOT} .sbacct-btn"); return { text: b.textContent, title: b.title, label: b.getAttribute("aria-label"), popup: b.getAttribute("aria-haspopup") }; })()`);
  check(btn.text === "A" && btn.title === "Ada Lovelace (ada@example.org)" && btn.label === "Account: Ada Lovelace (ada@example.org)" && btn.popup === "menu", "…its initial, the name and email its title", btn);
  await ev(`document.querySelector("${SLOT} .sbacct-btn").click()`);
  const menu = await ev(`(() => { const m = document.querySelector("${SLOT} .sbacct-menu"); return { open: !m.hidden, who: m.querySelector(".sbacct-who").innerText.replace(/\\s+/g, " ").trim(), items: [...m.querySelectorAll("button")].map((b) => b.textContent), expanded: document.querySelector("${SLOT} .sbacct-btn").getAttribute("aria-expanded"), focus: document.activeElement?.textContent }; })()`);
  await shot("notebook-signed-in-menu");
  check(menu.open && menu.who === "Ada Lovelace ada@example.org" && J(menu.items) === J(["Sync and storage…", "Sign out"]) && menu.expanded === "true" && menu.focus === "Sync and storage…", "its menu: who is signed in, Sync and storage…, Sign out (its first item focused)", menu);
  await ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  check(await ev(`document.querySelector("${SLOT} .sbacct-menu").hidden && document.activeElement === document.querySelector("${SLOT} .sbacct-btn")`), "Escape closes it, back to its button");
  await ev(`document.querySelector("${SLOT} .sbacct-btn").click()`);
  await ev(`[...document.querySelectorAll("${SLOT} .sbacct-menu button")].find((b) => b.textContent === "Sync and storage…").click()`);
  check(await until(`[...document.querySelectorAll(".sbfprev h4")].some((h) => h.textContent === "Sync")`, 8000), "Sync and storage… opens the Storage panel, with its sync section");
  await ev(`document.querySelector(".sbfprev .ph .x")?.click()`);

  // ---- File > Open…'s dialog: no account in it
  await ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true })), 1)`);
  check(await until(`!!document.querySelector(".sbfopen .sbfiles")`, 5000) && await ev(`!document.querySelector(".sbfopen .facct, .sbfopen .sbacct")`), "File > Open…'s dialog: no account in it");
  await ev(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1)`);
  await until(`!document.querySelector(".sbfopen")`, 5000);

  // ---- Sign out
  await ev(`window.__before = 1, 1`);
  await ev(`document.querySelector("${SLOT} .sbacct-btn").click()`);
  await ev(`[...document.querySelectorAll("${SLOT} .sbacct-menu button")].find((b) => b.textContent === "Sign out").click()`);
  check(await until(`!window.__before && document.readyState === "complete"`, 15000), "Sign out asks the server to sign out, then reloads the page");
  check(J(logouts) === J(["POST"]), "…after the site's sign-out (POST /auth/logout)", logouts);
  check(await until(`document.querySelector("${SLOT} a")?.textContent === "Sign in"`, 15000), "…and the page is signed out: \"Sign in\"");

  // ---- the board page: the same control, right of its Share
  const B = '#board [data-sbb="acct"]';
  mode = "out";
  check(await load(base + "board/"), "the board page, signed out: loaded");
  await until(`document.querySelector(${J(B + " a")})?.textContent === "Sign in"`, 10000); await shot("board-signed-out");
  check(await until(`document.querySelector(${J(B + " a")})?.textContent === "Sign in"`, 10000) && await ev(`document.querySelector(${J(B + " a")}).getAttribute("href") === ${signInWant}`), "the board page, signed out: \"Sign in\", back to this board");
  mode = "in";
  check(await load(base + "board/"), "the board page, signed in: loaded");
  check(await until(shown(B + " .sbacct-btn"), 10000), "the board page, signed in: the account's button");
  await ev(`document.querySelector(${J(B + " .sbacct-btn")}).click()`);
  const bItems = await ev(`[...document.querySelectorAll(${J(B + " .sbacct-menu button")})].map((b) => b.textContent)`);
  await shot("board-signed-in-menu");
  check(J(bItems) === J(["Sync and storage…", "Sign out"]), "…its menu", bItems);
  mode = "none";
  check(await load(base + "board/"), "the board page, a 404: loaded");
  check(await ev(`!(${shown(B)})`), "the board page, a 404: nothing");

  // ---- a phone: Sign in in the bar at the top, in the window, nothing over it
  await ev(`localStorage.setItem("sagebrush-files-sidebar", "0")`).catch(() => {});
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Network.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" });
  mode = "out";
  check(await load(), "a phone: loaded");
  check(await ev(`document.documentElement.classList.contains("phone")`), "…in the phone layout");
  check(await until(shown(SLOT + " a"), 8000), "a phone: \"Sign in\" shown");
  // (from the top of the page, as it opens: the phone layout scrolls with the page, its bar too)
  await ev(`(scrollTo(0, 0), document.scrollingElement && (document.scrollingElement.scrollTop = 0), 1)`); await sleep(200);
  await shot("phone-signed-out");
  const pa = await ev(rect(SLOT + " a"));
  const covered = await ev(`(() => { const a = document.querySelector("${SLOT} a"), r = a.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return a.contains(at) ? null : (at?.id || at?.className || at?.tagName); })()`);
  check(!!pa && pa.top >= 0 && pa.top < 120 && pa.right <= 390 && pa.left >= 0 && covered === null, "a phone: \"Sign in\" at the top, in the window, nothing over it", { pa, covered });
  check(errors.length === 0, "no uncaught exceptions", errors.slice(0, 3));
} catch (e) {
  check(false, "the test ran: " + (e?.stack ?? e));
} finally {
  const exited = new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once("exit", r)));
  chrome.kill();
  await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: the account in the page's bar, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
