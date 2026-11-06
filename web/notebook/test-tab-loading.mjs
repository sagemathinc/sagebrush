// ci: web-browser/notebook order=125
// A Tab whose answer is slow (the first Tab in a language waits for its
// environment to load, a few seconds on a cold start): after 300 ms the wait
// is shown at the caret, "loading <language>…", in the completion list's
// place, and the answer then replaces it; a quick answer shows no note; a key
// pressed meanwhile takes the note away, and a stale answer then shows
// nothing; an answer with no names takes it away too; an older Tab's answer
// leaves a newer Tab's note alone, and an older Tab's timer leaves a newer Tab's
// answer alone; a text, caret or focus change before 300 ms shows no note; the
// list's own keys still choose.  On the embed page (web/embed), its kernel's questions delayed
// here.  Serve web/dist first (python3 web/serve.py 8765), then
//   node web/notebook/test-tab-loading.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devtoolsPort } from "../test-port.mjs";

const base = process.env.SB_URL ?? "http://127.0.0.1:8765/";
let port = Number(process.env.CDP_PORT) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-tabwait-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, "--window-size=1280,800", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
if (!port) port = await devtoolsPort(profile);
let targets;
for (let i = 0; i < 300; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map(); const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const key = (k, vk) => send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: vk }).then(() => send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: vk }));
// the list as shown: [text of each item, whether it is the waiting note]
const shown = () => ev(`(() => { const c = document.querySelector(".sbnb-completer"); return c.hidden ? null : [...c.children].map((li) => [li.textContent, li.classList.contains("sbnb-comp-wait")]); })()`);
// a fresh code cell holding `text`, its caret at the end, focused
const fresh = (text) => ev(`(() => { const ta = [...document.querySelectorAll("#nb .cell textarea")].at(-1); ta.focus(); ta.value = ""; ta.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`).then(() => send("Input.insertText", { text }));

try {
  await send("Runtime.enable");
  await send("Page.navigate", { url: new URL("embed/", base).href });
  check(await until("window.demo?.kernel?.ready === true", 60000), "the embed page's kernel starts");
  // (each question answered after window.__delay ms, as a cold start's first Tab is)
  await ev(`(() => { const k = window.demo.kernel, ask = k.ask.bind(k); window.__delay = 0; window.__delays = []; k.ask = (...a) => new Promise((r) => setTimeout(r, window.__delays.shift() ?? window.__delay)).then(() => ask(...a)); return true; })()`);

  // a slow answer: the note after 300 ms, then the answer's list in its place
  await ev("window.__delay = 1500");
  await fresh("pri");
  await key("Tab", 9);
  await sleep(150);
  check((await shown()) === null, "no note before 300 ms");
  await sleep(450);
  const note = await shown();
  check(JSON.stringify(note) === JSON.stringify([["loading Sage…", true]]), `the note after 300 ms: ${JSON.stringify(note)}`);
  check(await until(`(() => { const c = document.querySelector(".sbnb-completer"); return !c.hidden && !c.querySelector(".sbnb-comp-wait") && [...c.children].some((li) => li.textContent === "print"); })()`, 5000), "the answer's list replaces the note");
  await key("Escape", 27);

  // a slow answer with no names: the note goes, and nothing is listed
  await fresh("zqzqzq");
  await key("Tab", 9);
  await sleep(600);
  check((await shown())?.[0]?.[1] === true, "the note shows for a slow answer with no names");
  check(await until(`document.querySelector(".sbnb-completer").hidden`, 5000), "...and goes when it arrives empty");

  // a quick answer: no note at all
  await ev("window.__delay = 50");
  await fresh("pri");
  await key("Tab", 9);
  let noted = false;
  for (let i = 0; i < 12; i++) { const s = await shown(); if (s?.some(([, w]) => w)) noted = true; await sleep(50); }
  check(!noted, "a quick answer shows no note");
  await key("Escape", 27);

  // a key while waiting: the note goes, and the answer, stale now, shows nothing
  await ev("window.__delay = 1500");
  await fresh("pri");
  await key("Tab", 9);
  await sleep(600);
  check((await shown())?.[0]?.[1] === true, "the note is shown before the key");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", text: "n", windowsVirtualKeyCode: 78 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", windowsVirtualKeyCode: 78 });
  await sleep(100);
  check((await shown()) === null, "a key takes the note away");
  await sleep(1600);
  check((await shown()) === null, "the stale answer shows nothing");

  // two Tabs overlapping (daybreak3's TAB689-RACE-1): an older answer, stale, arriving while a newer Tab waits,
  // leaves the newer one's note alone; the newer answer then shows its list
  await key("Escape", 27);
  await fresh("pri");
  await ev("window.__delays = [1200, 2500]");
  await key("Tab", 9);
  await sleep(400);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "n", code: "KeyN", text: "n", windowsVirtualKeyCode: 78 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "n", code: "KeyN", windowsVirtualKeyCode: 78 });
  await key("Tab", 9);
  await sleep(500);
  check((await shown())?.[0]?.[1] === true, "the newer Tab's note shows");
  await sleep(900);
  check((await shown())?.[0]?.[1] === true, "...and stays when the older, stale answer arrives");
  // (prin has one name: the answer completes it in the cell rather than listing it)
  check(await until(`(() => { const c = document.querySelector(".sbnb-completer"), ta = [...document.querySelectorAll("#nb .cell textarea")].at(-1); return !c.querySelector(".sbnb-comp-wait") && (ta.value === "print" || [...c.children].some((li) => li.textContent === "print")); })()`, 5000), "...until its own answer replaces it");
  await key("Escape", 27);

  // the list's own keys: ↓ then Enter inserts the second name
  await ev("window.__delay = 50; window.__delays = []");
  await fresh("pri");
  await key("Tab", 9);
  check(await until(`(() => { const c = document.querySelector(".sbnb-completer"); return !c.hidden && c.children.length > 1 && !c.querySelector(".sbnb-comp-wait"); })()`, 5000), "a quick answer lists several names");
  const second = (await shown())?.[1]?.[0];
  await key("ArrowDown", 40);
  await key("Enter", 13);
  await sleep(100);
  check(second && (await ev(`[...document.querySelectorAll("#nb .cell textarea")].at(-1).value`)) === second, `↓ then Enter inserts the second name (${second})`);
  check((await shown()) === null, "...and closes the list");

  // no note when the 300 ms come after the wait ended or no longer applies: sampled every 50 ms to 900 ms
  const quiet = async (what, during) => {
    await fresh("zqzqzq");
    await key("Tab", 9);
    await during();
    let seen = false;
    for (let i = 0; i < 18; i++) { if ((await shown())?.some(([, w]) => w)) seen = true; await sleep(50); }
    check(!seen, what);
    await key("Escape", 27);
  };
  await ev("window.__delay = 50");
  await quiet("a quick answer with no names shows no note later", () => sleep(0));
  await ev("window.__delay = 1500");
  // (the last character replaced: the text changes, the caret is back where it was)
  await quiet("the text changed before 300 ms: no note", () => sleep(100).then(() => ev(`(() => { const ta = document.activeElement; ta.setSelectionRange(ta.value.length - 1, ta.value.length); return true; })()`)).then(() => send("Input.insertText", { text: "x" })));
  await quiet("the caret moved before 300 ms: no note", () => sleep(100).then(() => key("ArrowLeft", 37)));
  await quiet("focus gone before 300 ms: no note", () => sleep(100).then(() => ev(`document.activeElement.blur(), true`)));
  await sleep(1600); // (the slow answers above, all stale, come back)

  // an older Tab's timer firing after a newer Tab answered quickly (daybreak3's TAB689-TIMER-2):
  // with no names, it shows no note; with a list open, it doesn't cover it
  await ev("window.__delays = [1000, 50]");
  await fresh("zqzqzq");
  await key("Tab", 9);
  await sleep(100);
  await key("Tab", 9);
  let resurrected = false;
  for (let i = 0; i < 30; i++) { if ((await shown())?.some(([, w]) => w)) resurrected = true; await sleep(50); }
  check(!resurrected, "an older timer after a newer empty answer: no note");
  check((await shown()) === null, "...and none after the older answer arrives");
  await ev("window.__delays = [1000, 50]");
  await fresh("pri");
  await key("Tab", 9);
  await sleep(100);
  await key("Tab", 9);
  // (the older timer fires before or after the newer list opens: no note either way)
  let covered = false;
  for (let i = 0; i < 30; i++) { if ((await shown())?.some(([, w]) => w)) covered = true; await sleep(50); }
  const kept = await shown();
  check(kept?.length > 1 && !kept.some(([, w]) => w), `a newer quick answer's list opens: ${JSON.stringify(kept)}`);
  check(!covered, "...and the older timer shows no note, over it or before it");
  await key("Escape", 27);
  check(errors.length === 0, `no page exceptions: ${errors.slice(0, 2).join(" | ")}`);
} catch (e) {
  fails.push("threw: " + (e?.stack ?? e));
} finally {
  ws.close();
  chrome.kill();
  // (Chromium may still be writing its profile as it exits)
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
}
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f);
process.exitCode = fails.length ? 1 : 0;
