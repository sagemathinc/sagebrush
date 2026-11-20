// ci: web-runner order=183 chrome
// The log mirror on the Agents page (/agents/, M2 design r4 §3, §5): the page (web/dist, served by web/serve.py with
// the site's headers) with the site's mirror routes answered by this test (Chromium's Fetch domain), so no agent is
// needed: the settings appear only where the mirror is available; the account's conversations this browser doesn't
// have are listed with a "mirror" badge; one opens read-only, as separately labeled sections, a gap line for a
// segment that couldn't be read and "Not confirmed by your agent" from the stream's stale mark, with no composer and
// nothing to press but its delete; the switch, its words, the confirmation before turning it off, and the storage line.
//   bun web/build.ts && CHROME=chromium node web/agents/test-agents-mirror.mjs [--shots DIR]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const here = new URL(".", import.meta.url).pathname;
const shots = process.argv.includes("--shots") ? process.argv[process.argv.indexOf("--shots") + 1] : null;
let failures = 0, checks = 0;
const ok = (c, msg, detail) => { checks++; console.log((c ? "ok   " : "FAIL ") + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 600))); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("python3", ["-u", join(here, "..", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
const sport = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
const origin = `http://127.0.0.1:${sport}`;

// ---- the site's mirror routes, as this test answers them
const LOC = "0123456789abcdef0123456789abcdef";
const INST = "aaaaaaaa00000001";
const fake = { on: true, pending: 0, calls: [], deleted: false, available: true, staleFrom: 5 };
const segs = [
  { first_n: 1, last_n: 2, entries: [{ k: "user", n: 1, seq: 1, id: "u1", text: "Plot the partial sums\nof a Fourier series" }, { k: "turn_started", n: 2, seq: 2, turn: "T1" }] },
  { first_n: 3, last_n: 3, missing: true },
  { first_n: 4, last_n: 7, entries: [
    { k: "message_revised", n: 4, seq: 4, turn: "T1", message: "m1", revision: 0 },
    { k: "text", n: 5, seq: 5, turn: "T1", message: "m1", revision: 0, text: "Here is <b>the</b> plot." },
    { k: "approval", n: 6, seq: 6, turn: "T1", id: "q1", kind: "tool", state: "open", title: "Run a command" },
    { k: "turn_finished", n: 7, seq: 7, turn: "T1", outcome: "completed" },
  ] },
];
function answer(method, path, body) {
  fake.calls.push([method, path]);
  if (!fake.available) return [404, { error: "not found" }];
  if (path === "/api/mirror/v1/status") return [200, { available: true, state: fake.on ? "on" : "off", bytes: 1234, quota: 5e9, pending: fake.pending, conversations: 1, csrf: "tok" }];
  if (path === "/api/mirror/v1/disable") { fake.on = false; fake.pending = 2; setTimeout(() => (fake.pending = 0), 1500); return [200, { state: "off" }]; }
  if (path === "/api/mirror/v1/enable") { fake.on = true; return [200, { state: "on" }]; }
  if (path === "/api/mirror/v1/conversations" && method === "GET")
    return [200, { conversations: fake.on && !fake.deleted ? [{ conversation: "remote-1", locator: LOC, mode: "B", streams: [{ log_instance: INST, next_n: 8, last_seq: 7, last_digest: "x", stale_from: fake.staleFrom, stale_reason: "differs" }] }] : [] }];
  if (path === `/api/mirror/v1/conversations/${LOC}` && method === "DELETE") { fake.deleted = true; return [200, {}]; }
  const m = path.match(/^\/api\/mirror\/v1\/read\/[0-9a-f]{32}\/[A-Za-z0-9_-]+\?after=(\d+)$/);
  if (m) {
    const g = segs.find((s) => s.first_n === +m[1] + 1);
    const stale = { stale_from: fake.staleFrom, stale_reason: "differs" };
    if (!g) return [200, { end: true, ...stale }];
    if (g.missing) return [200, { missing: true, reason: "corrupt", first_n: g.first_n, last_n: g.last_n, ...stale }];
    return [200, { log_instance: INST, first_n: g.first_n, last_n: g.last_n, entries: g.entries, ...stale }];
  }
  return [404, { error: "not found" }];
}

let cdp = Number(process.env.CDP_PORT) || 0;
const profile = mkdtempSync(join(tmpdir(), "sb-agents-mirror-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${cdp}`, "--window-size=1300,850", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
try {
  if (!cdp) cdp = await devtoolsPort(profile);
  let targets;
  for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json(); break; } catch { await sleep(100); } }
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let n = 0;
  const waiting = new Map();
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++n; const t = setTimeout(() => j(new Error("CDP timeout: " + method)), 30000); waiting.set(id, (m) => { clearTimeout(t); r(m); }); sock.send(JSON.stringify({ id, method, params })); });
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === "Fetch.requestPaused") {
      const u = new URL(m.params.request.url);
      const [status, body] = answer(m.params.request.method, u.pathname + u.search, m.params.request.postData);
      void send("Fetch.fulfillRequest", { requestId: m.params.requestId, responseCode: status, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
    }
  };
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (!r.result || r.result.exceptionDetails) throw new Error(JSON.stringify(r.result?.exceptionDetails ?? r.error ?? r).slice(0, 300)); return r.result.result.value; };
  const until = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const shot = async (name) => { if (!shots) return; const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(shots, name + ".png"), Buffer.from(r.result.data, "base64")); };
  for (const m of ["Page.enable", "Runtime.enable"]) await send(m);
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/mirror/*" }] });

  // ---- where the mirror isn't available to the person: nothing of it shows
  fake.available = false;
  await send("Page.navigate", { url: `${origin}/agents/` });
  ok(await until(`!!document.querySelector("#threads") && document.querySelectorAll("#threads .thread").length > 0`, 60000), "the Agents page loads");
  await until(`window.performance.getEntriesByType("resource").some((e) => e.name.includes("/api/mirror/v1/status"))`, 10000);
  await sleep(300);
  ok(await ev(`document.querySelector("#mirror-btn").hidden && !document.querySelector("#threads .thread.mirror")`), "the mirror unavailable (the site answers 404): no Mirror button, no mirrored conversations");

  // ---- available and on
  fake.available = true;
  await send("Page.reload");
  ok(await until(`!document.querySelector("#mirror-btn").hidden`), "available: the Mirror… button shows");
  ok(await until(`!!document.querySelector("#threads .thread.mirror")`), "the account's conversation this browser doesn't have is listed");
  const item = await ev(`(() => { const b = document.querySelector("#threads .thread.mirror"); return { text: b.textContent, badge: b.querySelector(".badge")?.textContent }; })()`);
  ok(item.badge === "mirror" && item.text.startsWith("Mirrored conversation"), "with a small mirror badge, in the same list (Q2)", item);
  await ev(`(document.querySelector("#threads .thread.mirror").click(), true)`);
  ok(await until(`!document.querySelector("#mirror-log").hidden && !!document.querySelector("#mirror-log .mirror-section")`), "opening it shows its sections");
  const v = await ev(`(() => {
    const log = document.querySelector("#mirror-log");
    const vis = (s) => { const e = document.querySelector(s); return !!e && !e.hidden && getComputedStyle(e).display !== "none"; };
    return {
      label: log.querySelector(".mirror-label")?.textContent,
      gap: [...log.querySelectorAll(".mirror-gap")].map((e) => e.textContent),
      order: [...log.querySelectorAll(".mirror-section > *")].map((e) => e.classList.contains("mirror-gap") ? "gap" : e.classList.contains("mirror-unconfirmed") ? "label" : e.classList.contains("user") ? "user" : e.classList.contains("turn") ? (e.querySelector(".msg") ? "turn-text" : "turn") : e.className),
      unconfirmed: log.querySelector(".mirror-unconfirmed")?.textContent,
      unconfirmedBlocks: [...log.querySelectorAll(".unconfirmed")].length,
      user: log.querySelector(".user .bubble")?.textContent,
      text: log.querySelector(".turn .msg")?.textContent,
      bold: !!log.querySelector("b"),
      approval: log.querySelector(".mirror-approval")?.textContent,
      buttons: log.querySelectorAll("button, input, textarea, [contenteditable], a").length,
      composer: vis(".composer-wrap"),
      readonly: vis("#mirror-readonly"),
      readonlyText: document.querySelector("#mirror-readonly-text").textContent,
      del: document.querySelector("#mirror-delete-one").textContent,
      log: vis("#log"),
      title: document.querySelector("#threads .thread.mirror").firstChild.textContent,
      on: document.querySelector("#threads .thread.mirror").classList.contains("on"),
    };
  })()`);
  ok(v.label === "Uploaded by your page", "S7b: its stream is a section labeled \"Uploaded by your page\"", v);
  ok(v.gap.length === 1 && v.gap[0] === "Part of this conversation couldn't be read", "a segment that couldn't be read is a gap line, never partial text", v.gap);
  ok(JSON.stringify(v.order) === JSON.stringify(["mirror-label", "user", "turn", "gap", "label", "turn-text"]), "the gap line where the gap is: a turn it falls in ends there, what follows comes after it", v.order);
  ok(v.unconfirmed === "Not confirmed by your agent: it differs from your agent's history" && v.unconfirmedBlocks >= 1, "from the stream's stale mark on: \"Not confirmed by your agent\" with the reason", v);
  ok(v.user === "Plot the partial sums\nof a Fourier series" && v.text === "Here is <b>the</b> plot." && !v.bold, "messages drawn as text: markup in them is text, never HTML", v);
  ok(v.approval === "⚠ Run a command: No answer" && v.buttons === 0, "S7c: an open approval is a plain line; nothing in the conversation can be pressed or typed into", v);
  ok(!v.composer && v.readonly && v.readonlyText === "This is the copy in your account, and it's read-only. To continue this conversation, connect the agent that has it." && v.del === "Delete this conversation's mirrored copy", "S7c: no composer; the read-only line, with the per-conversation delete", v);
  ok(!v.log && v.title === "Plot the partial sums" && v.on, "the thread's own log is hidden; the list names it by its first line and marks it current", v);
  await shot("mirror-view");
  // (no composer to type in: the editor can't take the focus, so typing and Shift+Enter post nothing, not even to the
  //  scripted demo, which would answer any message in this page; the chats kept show no new message)
  const entries = `(() => { try { return JSON.parse(localStorage.getItem("sagebrush-agents-preview-v1")).threads.reduce((n, t) => n + t.entries.length, 0); } catch { return -1; } })()`;
  await sleep(400);
  const kept0 = await ev(entries);
  const focused = await ev(`(() => { const e = document.querySelector("#editor [contenteditable], #editor textarea"); e?.focus(); return !!e && document.activeElement === e; })()`);
  await send("Input.insertText", { text: "continue it" });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
  await sleep(800);
  ok(!focused && (await ev(entries)) === kept0 && !(await ev(`document.body.innerText.includes("continue it")`)), "S7c: the editor can't be focused there, and typing with Shift+Enter posts nothing", { focused, before: kept0, after: await ev(entries) });

  // ---- reopened, it is read again: a mark set meanwhile shows
  fake.staleFrom = 2;
  await ev(`(document.querySelector("#threads .thread:not(.mirror)").click(), true)`);
  ok(await until(`document.querySelector("#mirror-log").hidden && !document.querySelector(".composer-wrap").hidden && !document.querySelector("#log").hidden`), "a chat of this browser's: the composer and its log are back");
  await ev(`(document.querySelector("#threads .thread.mirror").click(), true)`);
  ok(await until(`[...document.querySelectorAll("#mirror-log .mirror-section > *")].findIndex((e) => e.classList.contains("mirror-unconfirmed")) === 2`), "reopened: read again, the mark set meanwhile drawn (now before the turn)");
  // ---- ＋ New chat from a mirrored conversation: closes it, and the new chat has its composer
  await ev(`(document.querySelector("#new").click(), true)`);
  ok(await until(`document.querySelector("#mirror-log").hidden && !document.querySelector(".composer-wrap").hidden && document.querySelector("#threads .thread.on")?.textContent === "New chat"`), "＋ New chat from a mirrored conversation: it closes, the new chat with its composer");
  fake.staleFrom = 5;

  // ---- the settings
  await ev(`(document.querySelector("#mirror-btn").click(), true)`);
  ok(await until(`document.querySelector("#mirror-dlg").open`), "Mirror… opens the settings");
  const s1 = await ev(`(() => ({ label: document.querySelector("#mirror-switch-label").textContent, on: document.querySelector("#mirror-switch").checked, about: document.querySelector("#mirror-about").textContent, lines: [...document.querySelectorAll("#mirror-lines div")].map((d) => d.textContent) }))()`);
  ok(s1.label === "Keep your agent conversations in your Sagebrush account" && s1.on, "the switch, on", s1);
  ok(s1.about.includes("Sagebrush and Cloudflare can read your mirrored history.") && s1.about.startsWith("Uploaded by your pages:"), "while on: what's uploaded and who can read it", s1.about);
  ok(s1.lines.includes("Mirror: 1.2 KB of your 5.0 GB") || s1.lines.includes("Mirror: 1.2 KB of your 5 GB"), "the storage line", s1.lines);
  await shot("mirror-settings");
  await ev(`(() => { const s = document.querySelector("#mirror-switch"); s.click(); return true; })()`);
  const c1 = await ev(`(() => ({ confirm: !document.querySelector("#mirror-confirm").hidden, text: document.querySelector("#mirror-confirm-text").textContent, yes: document.querySelector("#mirror-confirm-yes").textContent, still: document.querySelector("#mirror-switch").checked }))()`);
  ok(c1.confirm && c1.still && c1.text.startsWith("Turn off and delete your mirrored history?") && c1.yes === "Turn off and delete", "turning it off asks first, in its own words; still on meanwhile", c1);
  ok(!fake.calls.some(([, p]) => p === "/api/mirror/v1/disable"), "nothing deleted before the person says so");
  await ev(`(document.querySelector("#mirror-confirm-no").click(), true)`);
  ok(await ev(`document.querySelector("#mirror-confirm").hidden && document.querySelector("#mirror-switch").checked`), "Cancel: still on, nothing asked");
  await ev(`(document.querySelector("#mirror-switch").click(), true)`);
  await ev(`(document.querySelector("#mirror-confirm-yes").click(), true)`);
  ok(await until(`[...document.querySelectorAll("#mirror-lines div")].some((d) => d.textContent === "Deleting mirrored history…")`), "confirmed: off, and \"Deleting mirrored history…\" while the account's object says some is pending");
  ok(fake.calls.some(([m, p]) => m === "POST" && p === "/api/mirror/v1/disable"), "the disable request went");
  ok(await until(`[...document.querySelectorAll("#mirror-lines div")].some((d) => d.textContent === "Mirrored history deleted")`, 15000), "\"Mirrored history deleted\" only once nothing is pending");
  ok(await ev(`!document.querySelector("#mirror-switch").checked && document.querySelector("#mirror-about").textContent.startsWith("Your conversations live on the computer")`), "off: the switch off, and the words for off");
  await ev(`(document.querySelector("#mirror-close").click(), true)`);
  ok(await until(`!document.querySelector("#threads .thread.mirror")`), "off: no mirrored conversations listed");

  // ---- deleting one conversation's copy
  fake.on = true;
  await send("Page.reload");
  ok(await until(`!!document.querySelector("#threads .thread.mirror")`), "on again: listed");
  await ev(`(document.querySelector("#threads .thread.mirror").click(), true)`);
  await until(`!document.querySelector("#mirror-readonly").hidden`);
  await ev(`(document.querySelector("#mirror-delete-one").click(), true)`);
  ok(await until(`!document.querySelector("#threads .thread.mirror") && document.querySelector("#mirror-log").hidden`), "its delete: the copy is deleted, gone from the list, and the page back on a chat of its own");
  ok(fake.calls.some(([m, p]) => m === "DELETE" && p === `/api/mirror/v1/conversations/${LOC}`), "the delete request went for that conversation's locator");
} catch (e) {
  ok(false, "the test ran to its end: " + (e?.stack ?? e));
} finally {
  server.kill();
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
console.log(failures ? `FAIL: ${failures} of ${checks}` : `ok: the log mirror on the Agents page, ${checks} checks`);
process.exit(failures ? 1 : 0);
